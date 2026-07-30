// The one place that decides *when* a dead-room snapshot is written (task 7.5).
//
// rooms/lifecycle.js's `destroyRoom()` decides when a snapshot is *taken*; this module
// decides when it reaches Postgres. Splitting those two moments is the whole
// point, and it buys two different things:
//
//   1. A concurrency cap. Before this existed, `destroyRoom` called
//      `db.saveDeadRoom()` directly and forgot it, so N rooms dying at once meant
//      N concurrent `pool.connect()` calls against a pool of POOL_MAX. Everything
//      past the cap waits in pg-pool's pending queue, where `connectionTimeoutMillis`
//      eventually rejects it with "timeout exceeded when trying to connect" — and
//      the room is already gone, so the snapshot is lost with nothing to retry
//      from. Measured before the fix: **10 rooms dying together, 3 saved, 7 lost**,
//      exactly the pool size. Every Railway redeploy with more than a handful of
//      live rooms hit this, because the shutdown flush destroys them all at once.
//
//   2. tasks.md §7.5's "rate-limit DB writes the same way v1 rate-limits room
//      creation" — the same sliding window from rateLimit.js that `POST /rooms`
//      uses, keyed on the room creator's IP.
//
// THE RULE THAT SHAPES EVERYTHING BELOW: pacing DEFERS, it never drops. A rate
// limiter that refuses a room's only snapshot destroys a user's work to protect a
// database, which is a worse outcome than the load it is avoiding — and the
// legitimate case that trips it is a shared NAT (a classroom behind one egress IP
// closing thirty rooms at 5pm), not an attacker. Only the queue's own memory
// bounds discard anything, and they log loudly when they do.

const { createRateLimiter } = require("../http/rateLimit");
const db = require("./db");

// Deliberately NOT 10, which is what `POST /rooms` uses and what a first reading
// of §7.5 suggests. Ten would be near-useless as a bound and actively harmful as
// a delay: room creation is already capped at 10/min/IP, and a snapshot
// additionally requires a signed-in member who stayed MEMBER_MIN_CONNECTED_MS
// *and* edited, so the achievable write rate per IP is already ≤10/min and costs
// 60s of connected time per room. The limiter would therefore almost never bind
// on abuse, and would bind constantly on the shared-NAT case above — holding
// thirty legitimate snapshots in memory for minutes, where an unclean death
// (OOM, SIGKILL) loses them permanently, because the room is gone and `room_id`
// is UNIQUE so nothing can re-derive them.
//
// 60/min sits well above any plausible simultaneous-death burst and still bounds
// a farm. Both values are env-overridable so the deferral path can be exercised
// in seconds during testing.
const WRITE_LIMIT = Number(process.env.SNAPSHOT_WRITE_LIMIT) || 60;
const WRITE_WINDOW_MS = Number(process.env.SNAPSHOT_WRITE_WINDOW_MS) || 60_000;

// What the queue may hold, bounded two ways because neither alone is honest.
//
// Bytes are the real bound: a snapshot is up to MAX_SNAPSHOT_BYTES (256 KB), so
// "64 entries" is 0.1 MB of ordinary rooms or 16 MB of capped ones. Holding tens
// of MB competes with the Y.Docs of *live* rooms on a Railway container, and an
// OOM there loses the queue **and** every live room — strictly worse than the
// unbounded writes this replaced.
//
// The entry count is the secondary guard against many tiny snapshots, and its
// value is derived rather than picked: a shutdown flush drains
// `SNAPSHOT_FLUSH_MS / per-write × POOL_MAX` writes, which at the measured
// ~0.8-2s per write and a 20s deadline is roughly 30-70. Queueing far past what
// a flush can drain is memory that can provably never be written. Keep these
// three in step — see db.js's `connectionTimeoutMillis` comment for the same
// coupling one layer down.
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_ENTRIES = 64;

// No single key may hold more than a quarter of the queue. Without this, one
// caller generating snapshots faster than their window allows fills the queue
// with their own deferred entries, and every *other* room's snapshot is then
// dropped at the door — the limiter would have converted abuse into a queue and
// the queue would have converted it into somebody else's data loss. Same
// reasoning as MAX_RESERVATIONS vs. the per-IP limiter in CLAUDE.md: a global
// ceiling and a per-caller bound do different jobs and both are needed.
const MAX_QUEUED_PER_KEY = Math.max(1, Math.floor(MAX_QUEUED_ENTRIES / 4));

/** Its own limiter instance, never shared with `POST /rooms`'. Sharing the map
 * would let a snapshot write consume a room-creation slot, which would surface
 * to a user as a spurious 429 on a room they were trying to make. */
const checkPace = createRateLimiter({ limit: WRITE_LIMIT, windowMs: WRITE_WINDOW_MS });

/** @typedef {{snapshot: object, key: string, bytes: number, resolve: (r: string) => void}} Entry */

/** @type {Entry[]} Waiting to be written. Not the ones in flight. */
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

/** Every pump entry point is wrapped in this. The in-flight writes form a
 * *chain* — write N completing is what starts write N+1 — so a throw anywhere in
 * it breaks the chain, and since the process is mid-shutdown with no other
 * handles, the event loop then drains and the rest of the queue is lost. */
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

/**
 * The first entry the limiter will allow right now, or -1 with the shortest wait
 * across everything queued.
 *
 * Scanning past a *denied* entry is free: `check()` records a hit only on its
 * allowed branch (rateLimit.js), so a refusal costs nothing. That is what lets
 * one throttled key be skipped rather than head-of-line-blocking every other
 * room behind it.
 *
 * An *allowed* result, however, consumes a slot — so this must only ever be
 * called with a worker free, and the caller must start the entry it returns
 * immediately. A slot consumed for a write that then does not happen is a write
 * the limiter counted and nobody made, which decays the effective rate below the
 * nominal one. That is also why this returns on the first allowed entry instead
 * of scanning the whole queue to find a minimum: re-checking a key that already
 * answered "allowed" would consume a second slot.
 */
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

/**
 * Re-armed on every pump rather than left alone, because the shortest wait
 * changes as keys' windows drain: a timer set for a key that frees in 58s must
 * not hold up an entry whose key frees in 2. `retryAfterSeconds` is always ≥1
 * (rateLimit.js), so re-arming cannot busy-loop.
 *
 * unref'd, like every other timer in this process — and safe only because
 * `releasePacing()` cancels it at SIGTERM. An unref'd timer holds nothing open,
 * so a queue parked behind one during a shutdown would simply never be written:
 * `server.close()` has already released the listen handle and Node's signal
 * handles do not anchor the loop either, so the process would exit with the
 * snapshots still in memory.
 */
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

  // Once per paced episode, not once per pump — every enqueue pumps, and a burst
  // of thirty would otherwise log thirty identical lines.
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
    // `saveDeadRoom` is documented never to reject, and since 7.5 that is
    // actually true (its `pool.connect()` moved inside the try). The rejection
    // handler stays anyway: this chain has no other catcher, and an unhandled
    // rejection is fatal under Node's default, which would take every live room
    // with it.
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

/**
 * Hands a snapshot over to be written. Resolves with `saveDeadRoom`'s status, or
 * `"dropped"` if the queue refused it.
 *
 * NEVER throws and never rejects. The only caller is `destroyRoom`, which runs
 * inside an unref'd `setTimeout` — a synchronous throw there is an uncaught
 * exception that kills the process and every other live room, which is the exact
 * failure `destroyRoom`'s own try/catch exists to prevent.
 *
 * Every path resolves, including the dropped ones. An entry whose promise never
 * settles sits in `pendingWrites` forever, and `flushAndDestroyAll`'s
 * `Promise.race` would then always resolve via the deadline branch — making
 * every shutdown, healthy or not, cost the full SNAPSHOT_FLUSH_MS.
 */
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
      // Room ID and depth only. `key` is a client IP: this process already bans
      // logging `req.url` for carrying a Clerk token, and the same rule applies
      // to an address that now lives in memory for minutes rather than being
      // consumed instantly.
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

/**
 * Turns pacing off for the rest of the process's life and drains what is waiting.
 * Called by `flushAndDestroyAll()` *before* it destroys anything, so no room
 * destroyed during a shutdown can re-arm a pacing timer behind the flush's back.
 *
 * The synchronous `pump()` is the load-bearing part, not the flag. By the time a
 * shutdown reaches here `server.close()` has already released the listening
 * handle, Node's signal handles never held the loop open, and the flush deadline
 * timer is unref'd — so if this only set a flag and waited for something else to
 * pump, a queue with no live rooms behind it would have nothing anchoring the
 * event loop at all, and Node would exit before writing a single row. Pumping
 * here opens real sockets, and those are what keep the process alive long enough
 * to finish.
 */
function releasePacing() {
  if (!pacingEnabled) return;
  pacingEnabled = false;
  clearTimer();
  safePump();
}

/**
 * Gives up on whatever is still queued, once the flush deadline has passed and
 * the pool is about to close. Without this those entries would be attempted
 * against an ended pool — `Cannot use a pool after calling end on the pool` —
 * and, worse, would never resolve.
 *
 * @returns {number} how many snapshots were abandoned
 */
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

/** Introspection for tests and logging. Never includes a key. */
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
