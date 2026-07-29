// The one place that decides whether a room exists.
//
// y-websocket only drops a doc when a persistence layer is configured, and this
// server has none — so left alone its `docs` map grows forever and every room
// lives forever. y-websocket creates docs; this module destroys them.
//
// A room's life has three stages:
//
//   reserved  -- POST /rooms handed out an ID; nobody has connected yet
//   live      -- at least one WebSocket is attached
//   grace     -- the last socket closed; the doc survives GRACE_MS in case that
//                was a page refresh, then is destroyed
//
// `roomExists` is true for all three, which is what makes a refresh work.
//
// Destruction is also where task 7.3's dead-room snapshot is taken — the one
// moment at which a room's final state still exists and nobody is left in it.
// See roomState.js for who a snapshot belongs to; this module only decides when.
const { docs } = require("y-websocket/bin/utils");
const crypto = require("crypto");
const db = require("./db");
const { createRoomState, deleteRoomState, buildSnapshot } = require("./roomState");

// How long an emptied room lingers. Non-zero on purpose: the last person
// pressing F5 briefly drops the connection count to zero, and instant
// destruction would delete their room out from under them.
const GRACE_MS = Number(process.env.ROOM_GRACE_MS) || 10_000;

// How long a created-but-never-entered room stays claimable. Covers someone who
// clicks "Create" and closes the tab before the editor connects.
const RESERVATION_MS = Number(process.env.ROOM_RESERVATION_MS) || 300_000;

// Reservations are the one thing an anonymous caller can create at will, so
// they get a ceiling. Live rooms need none — each costs a held-open socket.
const MAX_RESERVATIONS = 1000;

// How long a shutdown waits for in-flight snapshot writes before giving up.
//
// Must sit above db.js's connectionTimeoutMillis (10s): the pool is always cold
// at SIGTERM, and Neon autosuspends an idle branch, so the first act of a flush
// can be waking a database. It must also stay under the platform's
// SIGTERM-to-SIGKILL grace, which Railway does not let this file see — 20s is
// chosen to sit well inside a 30s window.
//
// This is a ceiling, not a delay: it resolves the moment the writes land, so a
// healthy shutdown still takes about a second.
const FLUSH_DEADLINE_MS = Number(process.env.SNAPSHOT_FLUSH_MS) || 20_000;

/** Set once a shutdown begins. Stops new evictions being scheduled. */
let shuttingDown = false;

/**
 * In-flight `saveDeadRoom` promises. A snapshot is fired and forgotten so it can
 * never delay room destruction, but a shutdown has to be able to wait for them —
 * this is the only handle on that. Entries remove themselves, so it never grows.
 */
const pendingWrites = new Set();

/** roomId -> timeout. Created via POST /rooms, nobody has connected yet. */
const reservations = new Map();

/** roomId -> timeout. Room is empty and inside its grace window. */
const evictions = new Map();

// Timers must never be the reason the process stays alive.
function unref(timer) {
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * Hands out a fresh room ID and holds it open for RESERVATION_MS.
 * Returns null when the reservation ceiling is hit, so the caller can answer 429.
 */
function reserveRoom() {
  if (reservations.size >= MAX_RESERVATIONS) return null;

  const roomId = crypto.randomUUID();
  // The only place that knows when a room was created — `created_at` on the
  // snapshot comes from here, and nothing else in the process records it.
  createRoomState(roomId);
  reservations.set(
    roomId,
    unref(
      setTimeout(() => {
        reservations.delete(roomId);
        // A reservation nobody claimed leaves no doc behind, so `destroyRoom`
        // never runs for it. Without this the state entry leaks forever.
        deleteRoomState(roomId);
      }, RESERVATION_MS),
    ),
  );
  return roomId;
}

/** The gate. A doc inside its grace window still counts as alive — that is the
 * whole point of the grace period. */
function roomExists(roomId) {
  return docs.has(roomId) || reservations.has(roomId);
}

/**
 * Called when a connection is accepted. The doc now carries the room's
 * existence, so the reservation is redundant — and whatever emptied the room a
 * moment ago clearly did not close it for good.
 */
function claimRoom(roomId) {
  // Defensive: a room reaching here always had a reservation, but state must
  // exist before the first connection binds observers to it.
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

/**
 * Called after a socket closes. Deletes the doc GRACE_MS later, but only if it
 * is still empty then — that re-check on fire, not just `claimRoom` cancelling
 * the timer, is what makes a reconnect during the window safe.
 */
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

/**
 * The single destroy site. Takes the dead-room snapshot, then destroys the doc.
 *
 * Deliberately NOT async, and nothing is awaited before `docs.delete()`. An
 * await there would leave a window in which `roomExists()` still answers true,
 * so a client could reconnect into a room whose snapshot is already committed —
 * a live room whose `room_id` is burned by the UNIQUE constraint, meaning its
 * real snapshot is later swallowed by ON CONFLICT DO NOTHING.
 *
 * That same `docs.delete()` is what makes this idempotent: the `has` check below
 * is a complete guard against the eviction timer racing the shutdown flush.
 *
 * Destruction is unconditional; snapshotting is best-effort. An uncaught throw
 * here would be an uncaught exception inside a setTimeout, killing the process
 * and every other live room with it.
 */
function destroyRoom(roomId, reason) {
  const doc = docs.get(roomId);
  if (!doc) return;
  docs.delete(roomId);

  let snapshot = null;
  try {
    // isEnabled() first so a server with no DATABASE_URL never touches any of
    // this, and buildSnapshot() returns null for a guest-only room before it
    // materialises the document — the common case costs nothing.
    if (db.isEnabled()) snapshot = buildSnapshot(roomId, doc, Date.now());
  } catch (err) {
    console.error(`Snapshot failed for ${roomId} (room destroyed anyway):`, err.message);
  }

  try {
    // Fires the awareness 'update' handler one final time (see roomState.js's
    // HARD RULE) — which is why the state entry is dropped *after* this, never
    // before.
    doc.destroy();
  } finally {
    deleteRoomState(roomId);
  }
  console.log(`Room destroyed: ${roomId} (${reason})`);

  if (!snapshot) return;

  const write = db
    .saveDeadRoom(snapshot)
    .then((result) => {
      if (result === "written") {
        console.log(`Dead room saved: ${roomId} (${snapshot.userIds.length} member(s))`);
      }
    })
    .catch((err) => console.error(`saveDeadRoom rejected for ${roomId}:`, err.message))
    .finally(() => pendingWrites.delete(write));
  pendingWrites.add(write);
}

/**
 * Destroys every remaining room and waits for its snapshot, for shutdown.
 *
 * Live rooms are destroyed too, and they are the entire point. Documents are
 * in-memory only and the room registry dies with the process, so every client in
 * a room is about to be sent home regardless (see the module comment): at
 * SIGTERM a live room *is* a dead room that has not noticed yet. Flushing only
 * rooms already inside their grace window would save the rooms nobody was using
 * and lose every room someone was working in, on every single deploy.
 *
 * This exists because the eviction timers are unref'd, so a queued eviction
 * simply never fires on SIGTERM. Invisible locally; guaranteed in production.
 */
function flushAndDestroyAll() {
  shuttingDown = true;

  // Copy the keys: destroyRoom mutates `docs` as it goes.
  for (const roomId of [...docs.keys()]) destroyRoom(roomId, "shutdown");

  return Promise.race([
    Promise.allSettled([...pendingWrites]),
    new Promise((resolve) => unref(setTimeout(resolve, FLUSH_DEADLINE_MS))),
  ]);
}

/** True once a shutdown has begun; new connections are refused after this. */
function isShuttingDown() {
  return shuttingDown;
}

module.exports = {
  GRACE_MS,
  RESERVATION_MS,
  FLUSH_DEADLINE_MS,
  reserveRoom,
  roomExists,
  claimRoom,
  scheduleEviction,
  destroyRoom,
  flushAndDestroyAll,
  isShuttingDown,
};
