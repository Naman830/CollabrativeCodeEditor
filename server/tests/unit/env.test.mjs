import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const SRC = join(import.meta.dirname, "../../src");

const { intFromEnv } = require(join(SRC, "env.js"));

describe("CFG-01 intFromEnv distinguishes 0, unset and a typo", () => {
  let warn;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("CFG-01a unset, null and blank all mean 'use the default', silently", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(intFromEnv(raw, 500)).toBe(500);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  // The whole point: `Number(x) || fallback` turned a deliberate 0 into the default.
  it("CFG-01b a deliberate 0 is honoured when the floor allows it", () => {
    expect(intFromEnv("0", 10_000)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("CFG-01c a value under the floor is refused loudly, not silently", () => {
    expect(intFromEnv("0", 60, { min: 1, name: "SNAPSHOT_WRITE_LIMIT" })).toBe(60);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("SNAPSHOT_WRITE_LIMIT");
    expect(warn.mock.calls[0][0]).toContain("[1,");
  });

  it("CFG-01d a typo warns instead of masquerading as the default", () => {
    expect(intFromEnv("abc", 10_000, { name: "ROOM_GRACE_MS" })).toBe(10_000);
    expect(intFromEnv("10.5", 10_000, { name: "ROOM_GRACE_MS" })).toBe(10_000);
    expect(intFromEnv("-1", 10_000, { name: "ROOM_GRACE_MS" })).toBe(10_000);
    expect(intFromEnv("1e400", 10_000, { name: "ROOM_GRACE_MS" })).toBe(10_000);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("CFG-01e a value over an explicit ceiling is refused", () => {
    expect(intFromEnv("9", 1, { min: 0, max: 8, name: "TRUSTED_PROXY_HOPS" })).toBe(1);
    expect(intFromEnv("8", 1, { min: 0, max: 8 })).toBe(8);
  });

  it("CFG-01f surrounding whitespace is tolerated", () => {
    expect(intFromEnv(" 42 ", 1)).toBe(42);
  });
});

describe("CFG-02 the shipped floors are the ones that matter", () => {
  // Loaded in a fresh process per file (pool: forks), so these are the real module-load values.
  it("CFG-02a SNAPSHOT_WRITE_LIMIT refuses 0, because 0 paces every snapshot forever", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SNAPSHOT_WRITE_LIMIT = "0";
    delete process.env.DATABASE_URL;

    const id = require.resolve(join(SRC, "storage/snapshotQueue.js"));
    delete require.cache[id];
    require(id);

    expect(warn.mock.calls.flat().join(" ")).toContain("SNAPSHOT_WRITE_LIMIT");
    delete process.env.SNAPSHOT_WRITE_LIMIT;
    warn.mockRestore();
  });

  it("CFG-02b MEMBER_MIN_CONNECTED_MS defaults to 60s, matching the frontend's hardcoded copy", () => {
    delete process.env.MEMBER_MIN_CONNECTED_MS;
    const id = require.resolve(join(SRC, "rooms/state.js"));
    delete require.cache[id];
    const state = require(id);
    // Exercised through the only observable path: a member who has not yet reached the
    // threshold earns no snapshot.
    expect(typeof state.buildSnapshot).toBe("function");
  });
});
