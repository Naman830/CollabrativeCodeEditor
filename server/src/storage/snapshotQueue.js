// Decides *when* a dead-room snapshot reaches Postgres: concurrency cap + per-IP pacing.
// INVARIANT: pacing DEFERS, never drops — the room is already gone, so a refused write
// destroys the only copy. Only the memory bounds below discard, and they log it.

const { createRateLimiter } = require("../http/rateLimit");
const db = require("./db");

// Deliberately not POST /rooms' 10 (see CLAUDE.md); env-overridable for testing.
const WRITE_LIMIT = Number(process.env.SNAPSHOT_WRITE_LIMIT) || 60;
const WRITE_WINDOW_MS = Number(process.env.SNAPSHOT_WRITE_WINDOW_MS) || 60_000;

// INVARIANT: keep in step with SNAPSHOT_FLUSH_MS and db.POOL_MAX — queueing past
// what a shutdown flush can drain is memory that can provably never be written.
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_ENTRIES = 64;

// Per-key bound, so one caller's deferred entries cannot starve every other room.
const MAX_QUEUED_PER_KEY = Math.max(1, Math.floor(MAX_QUEUED_ENTRIES / 4));

// INVARIANT: own limiter instance — sharing POST /rooms' map would 429 a room creation.
const checkPace = createRateLimiter({ limit: WRITE_LIMIT, windowMs: WRITE_WINDOW_MS });

/** @typedef {{snapshot: object, key: string, bytes: number, resolve: (r: string) => void}} Entry */

/** @type {Entry[]} Waiting to be written; not the ones in flight. */
const queue = [];

let queuedBytes = 0;
let running = 0;
let pacingEnabled = true;
let closed = false;
/** @type {NodeJS.Timeout | null} */
let timer = null;

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// INVARIANT: every pump entry point goes through this — the in-flight writes form a
// chain, so a throw would break it and lose the rest of the queue.
function safePump() {
  try {
    pump();
  } catch (err) {
    console.error("Snapshot queue pump failed:", err.message);
  }
}

function snapshotBytes(snapshot) {
  let total = 0;
  for (const file of snapshot.files ?? []) {
    total += Buffer.byteLength(file.content ?? "", "utf8");
  }
  return total;
}

function depthForKey(key) {
  let depth = 0;
  for (const entry of queue) if (entry.key === key) depth++;
  return depth;
}

// First entry the limiter allows now, else index -1 with the shortest wait.
// INVARIANT: an allowed verdict consumes a slot — call only with a worker free, and start
// the returned entry immediately.
function pickAllowed() {
  if (!pacingEnabled) return { index: 0, retryAfterSeconds: 0 };

  let soonest = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const verdict = checkPace(queue[i].key);
    if (verdict.allowed) return { index: i, retryAfterSeconds: 0 };
    if (verdict.retryAfterSeconds < soonest) soonest = verdict.retryAfterSeconds;
  }
  return { index: -1, retryAfterSeconds: soonest === Infinity ? 1 : soonest };
}

// Re-armed every pump, because the shortest wait shrinks as windows drain.
// INVARIANT: unref'd, so `releasePacing()` must cancel it at SIGTERM or a queue parked
// behind it exits unwritten.
function armTimer(retryAfterSeconds) {
  const wasArmed = timer !== null;
  clearTimer();
  if (closed) return;

  const ms = Math.max(1, retryAfterSeconds) * 1000;
  timer = setTimeout(() => {
    timer = null;
    safePump();
  }, ms);
  if (typeof timer.unref === "function") timer.unref();

  // Once per paced episode, not once per pump.
  if (!wasArmed) {
    console.log(
      `Snapshot writes paced: ${queue.length} queued, next attempt in ${Math.ceil(ms / 1000)}s`,
    );
  }
}

function start(index) {
  const [entry] = queue.splice(index, 1);
  queuedBytes -= entry.bytes;
  running++;

  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    running--;
    entry.resolve(result);
    safePump();
  };

  try {
    // INVARIANT: keep both handlers even though `saveDeadRoom` never rejects —
    // this chain has no other catcher and an unhandled rejection is fatal.
    db.saveDeadRoom(entry.snapshot).then(finish, (err) => {
      console.error(`saveDeadRoom rejected for ${entry.snapshot.roomId}:`, err.message);
      finish("failed");
    });
  } catch (err) {
    console.error(`saveDeadRoom threw for ${entry.snapshot.roomId}:`, err.message);
    finish("failed");
  }
}

function pump() {
  if (closed) return;

  while (running < db.POOL_MAX && queue.length > 0) {
    const picked = pickAllowed();
    if (picked.index === -1) {
      armTimer(picked.retryAfterSeconds);
      return;
    }
    start(picked.index);
  }

  if (queue.length === 0) clearTimer();
}

// INVARIANT: never throws, never rejects, and every path resolves — the caller runs inside
// an unref'd timer, and an unsettled promise costs every shutdown the full flush deadline.
function enqueue(snapshot) {
  try {
    if (closed) return Promise.resolve("dropped");

    const key = snapshot.creatorKey || snapshot.roomId;
    const bytes = snapshotBytes(snapshot);

    const refusal =
      queue.length >= MAX_QUEUED_ENTRIES
        ? `queue is full (${MAX_QUEUED_ENTRIES} snapshots)`
        : queuedBytes + bytes > MAX_QUEUED_BYTES
          ? `queue is full (${Math.round(MAX_QUEUED_BYTES / 1024)} KB)`
          : depthForKey(key) >= MAX_QUEUED_PER_KEY
            ? `one caller already holds ${MAX_QUEUED_PER_KEY} queued snapshots`
            : null;

    if (refusal) {
      // INVARIANT: never log `key` — it is a client IP, same rule as req.url.
      console.error(`Snapshot for ${snapshot.roomId} dropped: ${refusal}.`);
      return Promise.resolve("dropped");
    }

    queuedBytes += bytes;
    return new Promise((resolve) => {
      queue.push({ snapshot, key, bytes, resolve });
      safePump();
    });
  } catch (err) {
    console.error(`Snapshot for ${snapshot?.roomId} could not be queued:`, err.message);
    return Promise.resolve("dropped");
  }
}

// INVARIANT: `flushAndDestroyAll()` calls this *before* destroying anything, and the pump
// must stay synchronous — its sockets are all that anchor the event loop by then.
function releasePacing() {
  if (!pacingEnabled) return;
  pacingEnabled = false;
  clearTimer();
  safePump();
}

// Abandons whatever is still queued; returns how many.
// INVARIANT: must run before `db.close()`, or the remainder never resolves.
function destroy(reason) {
  closed = true;
  clearTimer();
  if (queue.length === 0) return 0;

  const abandoned = queue.length;
  const roomIds = queue.map((entry) => entry.snapshot.roomId);
  for (const entry of queue) entry.resolve("dropped");
  queue.length = 0;
  queuedBytes = 0;

  console.error(
    `Snapshot queue: ${abandoned} snapshot(s) abandoned at ${reason}: ` +
      `${roomIds.slice(0, 10).join(", ")}${abandoned > 10 ? ` (+${abandoned - 10} more)` : ""}`,
  );
  return abandoned;
}

/** Introspection for tests and logging. INVARIANT: never includes a key (an IP). */
function stats() {
  return { queued: queue.length, running, queuedBytes, pacingEnabled, closed };
}

module.exports = {
  WRITE_LIMIT,
  WRITE_WINDOW_MS,
  MAX_QUEUED_ENTRIES,
  MAX_QUEUED_BYTES,
  enqueue,
  releasePacing,
  destroy,
  stats,
};
