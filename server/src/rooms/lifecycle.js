// The one authority on whether a room exists, and the only place one is destroyed.
const { docs } = require("y-websocket/bin/utils");
const crypto = require("crypto");
const db = require("../storage/db");
const snapshotQueue = require("../storage/snapshotQueue");
const { createRoomState, deleteRoomState, buildSnapshot } = require("./state");
const { intFromEnv } = require("../env");

// 0 is legitimate here: destroy on the last disconnect, which is useful in tests.
const GRACE_MS = intFromEnv(process.env.ROOM_GRACE_MS, 10_000, { name: "ROOM_GRACE_MS" });

// Floor of 1s: 0 would expire the reservation before its creator can connect, breaking every
// room creation.
const RESERVATION_MS = intFromEnv(process.env.ROOM_RESERVATION_MS, 300_000, {
  min: 1_000,
  name: "ROOM_RESERVATION_MS",
});

// A deliberate non-env constant: a global ceiling on unclaimed rooms, unrelated to the
// per-caller limiter on POST /rooms. Both are needed — the limiter stops one script exhausting
// this, and this stops many callers doing it.
const MAX_RESERVATIONS = 1000;

// INVARIANT: must stay above db.js's connect timeout and under the platform's SIGTERM grace.
// 0 is legitimate: don't wait for snapshot writes at shutdown.
const FLUSH_DEADLINE_MS = intFromEnv(process.env.SNAPSHOT_FLUSH_MS, 20_000, {
  name: "SNAPSHOT_FLUSH_MS",
});

let shuttingDown = false;

// INVARIANT: every queued write promise must settle, or flushAndDestroyAll always waits
// out its full deadline.
const pendingWrites = new Set();

// roomId -> timeout. Reserved via POST /rooms; nobody has connected yet.
const reservations = new Map();

// roomId -> timeout. Room is empty and inside its grace window.
const evictions = new Map();

// Timers must never be the reason the process stays alive.
function unref(timer) {
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

// Returns null when the reservation ceiling is hit, so the caller can answer 429.
// INVARIANT: creatorKey is the creator's IP — a pacing key only, never written or logged.
function reserveRoom(creatorKey = null, language = null) {
  if (reservations.size >= MAX_RESERVATIONS) return null;

  const roomId = crypto.randomUUID();
  // The only place created_at and the room's language are recorded.
  createRoomState(roomId, creatorKey, language);
  reservations.set(
    roomId,
    unref(
      setTimeout(() => {
        reservations.delete(roomId);
        // destroyRoom never runs for an unclaimed reservation, so drop its state here.
        deleteRoomState(roomId);
      }, RESERVATION_MS),
    ),
  );
  return roomId;
}

// True for reserved, live and grace alike — which is what makes a page refresh survive.
function roomExists(roomId) {
  return docs.has(roomId) || reservations.has(roomId);
}

function claimRoom(roomId) {
  // State must exist before the first connection binds observers to it.
  createRoomState(roomId);

  const reservation = reservations.get(roomId);
  if (reservation) {
    clearTimeout(reservation);
    reservations.delete(roomId);
  }

  const eviction = evictions.get(roomId);
  if (eviction) {
    clearTimeout(eviction);
    evictions.delete(roomId);
  }
}

// INVARIANT: re-check emptiness when the timer fires, not just on cancel — a reconnect
// inside the grace window must keep its doc.
function scheduleEviction(roomId) {
  if (shuttingDown || evictions.has(roomId)) return;

  evictions.set(
    roomId,
    unref(
      setTimeout(() => {
        evictions.delete(roomId);
        if (shuttingDown) return;
        const doc = docs.get(roomId);
        if (!doc || doc.conns.size > 0) return;
        destroyRoom(roomId, "grace-expired");
      }, GRACE_MS),
    ),
  );
}

// INVARIANT: never async — nothing awaited before docs.delete(), or a client rejoins a room
// whose snapshot is committed. Snapshotting is best-effort: a throw here kills the process.
function destroyRoom(roomId, reason) {
  const doc = docs.get(roomId);
  if (!doc) return;
  docs.delete(roomId);

  let snapshot = null;
  try {
    if (db.isEnabled()) snapshot = buildSnapshot(roomId, doc, Date.now());
  } catch (err) {
    console.error(`Snapshot failed for ${roomId} (room destroyed anyway):`, err.message);
  }

  try {
    // INVARIANT: doc.destroy() re-fires awareness handlers, so deleteRoomState runs after it.
    doc.destroy();
  } finally {
    deleteRoomState(roomId);
  }
  console.log(`Room destroyed: ${roomId} (${reason})`);

  if (!snapshot) return;

  try {
    const write = snapshotQueue
      .enqueue(snapshot)
      .then((result) => {
        if (result === "written") {
          console.log(`Dead room saved: ${roomId} (${snapshot.userIds.length} member(s))`);
        }
      })
      .catch((err) => console.error(`Snapshot write failed for ${roomId}:`, err.message))
      .finally(() => pendingWrites.delete(write));
    pendingWrites.add(write);
  } catch (err) {
    console.error(`Could not queue snapshot for ${roomId}:`, err.message);
  }
}

// Split out of flushAndDestroyAll so /health can start answering 503 while the listener is
// still open. INVARIANT: idempotent, and flushAndDestroyAll still calls it — the flag has to be
// set before server.close(), or the platform sees a refused connection instead of the 503.
function beginShutdown() {
  shuttingDown = true;
}

// Shutdown: live rooms are destroyed too — at SIGTERM a live room is a dead room that has
// not noticed. The eviction timers are unref'd, so they never fire on their own.
function flushAndDestroyAll() {
  beginShutdown();

  // INVARIANT: before the destroy loop — it also starts parked writes, whose sockets are
  // the only thing anchoring the event loop once the listener is closed.
  snapshotQueue.releasePacing();

  // Copy the keys: destroyRoom mutates `docs` as it goes.
  for (const roomId of [...docs.keys()]) destroyRoom(roomId, "shutdown");

  return Promise.race([
    Promise.allSettled([...pendingWrites]),
    new Promise((resolve) => unref(setTimeout(resolve, FLUSH_DEADLINE_MS))),
  ]).then(() => {
    // INVARIANT: close the queue before index.js calls db.close(); the deadline branch can
    // win with writes still queued.
    snapshotQueue.destroy("the shutdown flush deadline");
  });
}

function isShuttingDown() {
  return shuttingDown;
}

module.exports = {
  GRACE_MS,
  RESERVATION_MS,
  MAX_RESERVATIONS,
  FLUSH_DEADLINE_MS,
  beginShutdown,
  reserveRoom,
  roomExists,
  claimRoom,
  scheduleEviction,
  destroyRoom,
  flushAndDestroyAll,
  isShuttingDown,
};
