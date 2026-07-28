// The one place that decides whether a room exists.
//
// y-websocket's `closeConn` only removes a doc from its `docs` map when a
// persistence layer is configured (`doc.conns.size === 0 && persistence !== null`),
// and this server deliberately has none — so without this module the map only ever
// grows and every room lives forever. Room *lifetime* is therefore ours to own:
// y-websocket creates docs, this module destroys them.
//
// A room's life has three stages:
//
//   reserved  -- POST /rooms handed out an ID; nobody has connected yet
//   live      -- at least one WebSocket is attached (the doc is in `docs`)
//   grace     -- the last socket closed; the doc survives GRACE_MS in case that
//                was a page refresh, then is deleted and destroyed
//
// `roomExists` is true for all three, which is exactly what makes a refresh work.
const { docs } = require("y-websocket/bin/utils");
const crypto = require("crypto");

// How long an emptied room lingers before being destroyed. Non-zero on purpose:
// the last person in a room pressing F5 briefly takes the connection count to
// zero, and instant destruction would delete their own room out from under them.
const GRACE_MS = Number(process.env.ROOM_GRACE_MS) || 10_000;

// How long a created-but-never-entered room stays claimable. Covers someone who
// clicks "Create" and closes the tab before the editor connects.
const RESERVATION_MS = Number(process.env.ROOM_RESERVATION_MS) || 300_000;

// Reservations are the one thing an unauthenticated caller can create at will,
// so they get a ceiling. Live rooms need no equivalent cap: each one costs a
// WebSocket connection to hold open.
const MAX_RESERVATIONS = 1000;

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
  reservations.set(
    roomId,
    unref(
      setTimeout(() => {
        reservations.delete(roomId);
      }, RESERVATION_MS),
    ),
  );
  return roomId;
}

/**
 * The gate. A doc still sitting in its grace window is present in `docs`, so a
 * refresh sees the room as alive — that is the whole point of the grace period.
 */
function roomExists(roomId) {
  return docs.has(roomId) || reservations.has(roomId);
}

/**
 * Called when a connection to `roomId` is accepted. The doc now carries the
 * room's existence, so the reservation is redundant; and whatever emptied the
 * room a moment ago clearly did not close it for good.
 */
function claimRoom(roomId) {
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
 * is still empty then: the re-check on fire — not just `claimRoom` cancelling
 * the timer — is what makes a reconnect during the window safe.
 */
function scheduleEviction(roomId) {
  if (evictions.has(roomId)) return;

  evictions.set(
    roomId,
    unref(
      setTimeout(() => {
        evictions.delete(roomId);
        const doc = docs.get(roomId);
        if (!doc || doc.conns.size > 0) return;
        docs.delete(roomId);
        doc.destroy();
        console.log(`Room destroyed: ${roomId}`);
      }, GRACE_MS),
    ),
  );
}

module.exports = {
  GRACE_MS,
  RESERVATION_MS,
  reserveRoom,
  roomExists,
  claimRoom,
  scheduleEviction,
};
