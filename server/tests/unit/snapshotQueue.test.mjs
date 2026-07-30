import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const SRC = join(import.meta.dirname, "../../src");
const QUEUE_PATH = require.resolve(join(SRC, "storage/snapshotQueue.js"));
const DB_PATH = require.resolve(join(SRC, "storage/db.js"));

/**
 * A fresh queue per test, with db patched on the required module object — which works because
 * snapshotQueue dereferences db.POOL_MAX inside its pump loop and db.saveDeadRoom at call time.
 * DATABASE_URL is deleted first so db.js opens no pool at all.
 */
function loadQueue({ poolMax = 3, env = {} } = {}) {
  delete process.env.DATABASE_URL;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[QUEUE_PATH];
  delete require.cache[DB_PATH];

  const db = require(DB_PATH);
  const pending = [];
  db.POOL_MAX = poolMax;
  db.saveDeadRoom = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });

  const queue = require(QUEUE_PATH);
  const tick = () => new Promise((r) => setImmediate(r));

  return {
    queue,
    db,
    pending,
    tick,
    settleOne: (r = "written") => pending.shift()?.(r),
    settleAll: (r = "written") => {
      while (pending.length) pending.shift()(r);
    },
    /**
     * Settling once is not enough: freeing a slot starts the next queued write, which pushes a
     * fresh resolver. Keep settling until nothing is pending, running or queued.
     */
    async drain(result = "written", rounds = 200) {
      for (let i = 0; i < rounds; i++) {
        while (pending.length) pending.shift()(result);
        await tick();
        const { running, queued } = queue.stats();
        if (!pending.length && running === 0 && queued === 0) return;
      }
    },
  };
}

const snapshot = (roomId, { key = "198.51.100.1", bytes = 10 } = {}) => ({
  roomId,
  creatorKey: key,
  userIds: ["user_1"],
  files: [{ filename: "main.py", content: "x".repeat(bytes) }],
  language: "python",
  isPrivate: false,
  participants: null,
  createdAt: new Date(0),
  diedAt: new Date(1),
});

afterEach(() => {
  for (const k of ["SNAPSHOT_WRITE_LIMIT", "SNAPSHOT_WRITE_WINDOW_MS"]) delete process.env[k];
  delete require.cache[QUEUE_PATH];
  delete require.cache[DB_PATH];
});

describe("PERF-02 the concurrency cap, which is the bug that lost 7 of 10 snapshots", () => {
  it("PERF-02a ten rooms dying at once run POOL_MAX at a time and queue the rest", async () => {
    const { queue, pending, drain } = loadQueue({ poolMax: 3 });
    const writes = Array.from({ length: 10 }, (_, i) => queue.enqueue(snapshot(`r${i}`)));
    await Promise.resolve();

    // Before the cap existed, all ten called pool.connect() at once against a pool of 3 and
    // seven were rejected by connectionTimeoutMillis with the room already gone.
    expect(queue.stats().running).toBe(3);
    expect(queue.stats().queued).toBe(7);
    expect(pending).toHaveLength(3);

    await drain();
    const results = await Promise.all(writes);
    // Nothing is dropped: all ten land.
    expect(results.filter((r) => r === "written")).toHaveLength(10);
    expect(queue.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("PERF-02b a worker frees exactly one slot", async () => {
    const { queue, settleOne, drain } = loadQueue({ poolMax: 3 });
    const writes = Array.from({ length: 6 }, (_, i) => queue.enqueue(snapshot(`r${i}`)));
    await Promise.resolve();
    expect(queue.stats()).toMatchObject({ running: 3, queued: 3 });

    settleOne();
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.stats().running).toBe(3);
    expect(queue.stats().queued).toBe(2);

    await drain();
    await Promise.all(writes);
  });

  it("PERF-02c POOL_MAX of 1 is strictly serial", async () => {
    const { queue, pending, drain } = loadQueue({ poolMax: 1 });
    const writes = Array.from({ length: 4 }, (_, i) => queue.enqueue(snapshot(`r${i}`)));
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    await drain();
    expect(await Promise.all(writes)).toHaveLength(4);
  });
});

describe("DI-05 the queue defers, and never drops for pacing reasons", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("DI-05a over-limit snapshots wait their turn rather than being refused", async () => {
    const { queue, settleAll } = loadQueue({
      poolMax: 3,
      env: { SNAPSHOT_WRITE_LIMIT: "2", SNAPSHOT_WRITE_WINDOW_MS: "1000" },
    });
    const writes = Array.from({ length: 5 }, (_, i) => queue.enqueue(snapshot(`r${i}`)));
    await Promise.resolve();
    expect(queue.stats().running).toBe(2);
    expect(queue.stats().queued).toBe(3);

    settleAll();
    await vi.advanceTimersByTimeAsync(1_100);
    settleAll();
    await vi.advanceTimersByTimeAsync(1_100);
    settleAll();
    await vi.advanceTimersByTimeAsync(1_100);
    settleAll();

    const results = await Promise.all(writes);
    // The room is already destroyed, so a refusal would destroy the only copy of that work.
    expect(results.every((r) => r === "written")).toBe(true);
  });

  it("DI-05b releasePacing pumps SYNCHRONOUSLY, which is what SIGTERM depends on", async () => {
    const { queue, settleAll, pending } = loadQueue({
      poolMax: 3,
      env: { SNAPSHOT_WRITE_LIMIT: "1", SNAPSHOT_WRITE_WINDOW_MS: "60000" },
    });
    const writes = [queue.enqueue(snapshot("a")), queue.enqueue(snapshot("b")), queue.enqueue(snapshot("c"))];
    await Promise.resolve();
    expect(queue.stats().queued).toBeGreaterThan(0);

    queue.releasePacing();
    // Asserted with no await in between: the pacing timer is unref'd, so if this only set a flag
    // Node would exit at shutdown with the snapshots still in memory.
    expect(queue.stats().running).toBeGreaterThan(1);

    for (let i = 0; i < 20 && (pending.length || queue.stats().queued); i++) {
      settleAll();
      await Promise.resolve();
      await Promise.resolve();
    }
    settleAll();
    await Promise.all(writes);
    queue.releasePacing(); // idempotent
  });
});

describe("DI-06 the memory bounds are the only thing that discards, and they say so", () => {
  it("DI-06a past MAX_QUEUED_ENTRIES a snapshot is dropped, loudly", async () => {
    const { queue, drain } = loadQueue({ poolMax: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const accepted = [];
    for (let i = 0; i < queue.MAX_QUEUED_ENTRIES + 5; i++) accepted.push(queue.enqueue(snapshot(`r${i}`)));
    const results = await Promise.all([
      ...accepted.slice(queue.MAX_QUEUED_ENTRIES + 1),
    ]);
    expect(results.some((r) => r === "dropped")).toBe(true);
    // A discard is never silent.
    expect(warn.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0);

    await drain();
    warn.mockRestore();
    error.mockRestore();
  });

  it("DI-06b a per-key bound stops one caller starving every other room", async () => {
    const { queue, drain } = loadQueue({ poolMax: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const noisy = [];
    for (let i = 0; i < 20; i++) noisy.push(queue.enqueue(snapshot(`noisy${i}`, { key: "1.1.1.1" })));
    // A different key still gets in even while the first is over its per-key bound.
    const other = await Promise.race([
      queue.enqueue(snapshot("other", { key: "2.2.2.2" })),
      new Promise((r) => setTimeout(() => r("pending"), 10)),
    ]);
    expect(other).not.toBe("dropped");

    await drain();
    await Promise.allSettled(noisy);
    vi.restoreAllMocks();
  });

  it("DI-06c destroy resolves every parked write rather than leaving a promise unsettled", async () => {
    // An unsettled promise makes flushAndDestroyAll's Promise.race always resolve via its
    // deadline branch, turning every shutdown into a full SNAPSHOT_FLUSH_MS wait.
    const { queue, settleAll } = loadQueue({ poolMax: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const writes = Array.from({ length: 5 }, (_, i) => queue.enqueue(snapshot(`r${i}`)));
    await Promise.resolve();

    queue.destroy("a test");
    settleAll();
    const results = await Promise.all(writes);
    expect(results).toHaveLength(5);
    expect(results.slice(1).every((r) => r === "dropped")).toBe(true);
    // Closed for good.
    expect(await queue.enqueue(snapshot("late"))).toBe("dropped");
    vi.restoreAllMocks();
  });

  it("DI-06d a failing write resolves 'failed' and the chain keeps draining", async () => {
    delete process.env.DATABASE_URL;
    delete require.cache[QUEUE_PATH];
    delete require.cache[DB_PATH];
    const db = require(DB_PATH);
    db.POOL_MAX = 2;
    let calls = 0;
    db.saveDeadRoom = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("written");
    };
    const queue = require(QUEUE_PATH);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await Promise.all([
      queue.enqueue(snapshot("a")),
      queue.enqueue(snapshot("b")),
      queue.enqueue(snapshot("c")),
    ]);
    expect(results).toContain("failed");
    expect(results.filter((r) => r === "written").length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });
});

describe("SEC-11 the creator's IP never leaves memory", () => {
  it("SEC-11a stats() exposes no key, and no log line carries one", async () => {
    const { queue, drain } = loadQueue({ poolMax: 1 });
    const logs = [];
    for (const level of ["log", "warn", "error"]) {
      vi.spyOn(console, level).mockImplementation((...args) => logs.push(args.join(" ")));
    }

    const KEY = "203.0.113.77";
    const writes = Array.from({ length: 30 }, (_, i) => queue.enqueue(snapshot(`r${i}`, { key: KEY })));
    await drain();
    await Promise.allSettled(writes);

    expect(Object.keys(queue.stats()).sort()).toEqual(
      ["closed", "pacingEnabled", "queued", "queuedBytes", "running"].sort()
    );
    // Same rule as the req.url logging ban: an address that lives in memory for minutes still
    // must not reach stdout.
    for (const line of logs) expect(line).not.toContain(KEY);
    vi.restoreAllMocks();
  });
});
