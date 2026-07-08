// Cross-instance Yjs sync wiring.
//
// SCAFFOLD ONLY: this module is where the Redis pub/sub fan-out will connect to
// the Yjs document lifecycle. None of the core logic is implemented yet — the
// handlers below are intentionally empty and marked with TODO(core-logic).
//
// The intended flow, for context:
//   local Y.Doc "update"  --publish-->  Redis  --deliver-->  other instances
//                                                              --apply--> their Y.Doc
// so that clients connected to different server instances converge on the same
// document even though y-websocket only broadcasts within a single process.
const { publisher, subscriber } = require("./client");
const { syncChannel } = require("./channels");
const { INSTANCE_ID } = require("../instanceId");

// Per-room "update" listener this module has attached, so a room that already
// has cross-instance sync wired up doesn't get a duplicate listener each time
// startRoomSync is called again (getYDoc's Y.Doc is shared across every
// connection to the room, same reasoning as persistedRooms in
// yjsConnection.js). Also lets stopRoomSync remove the exact listener
// instance it added.
const roomSyncListeners = new Map(); // roomId -> update listener function

/**
 * Begin mirroring a room's Yjs updates across instances.
 *
 * Called once per room this instance starts hosting (i.e. where a first client
 * connects). Invoked from the Yjs connection setup in yjsConnection.js.
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc  The shared per-room Y.Doc from getYDoc().
 */
function startRoomSync(roomId, ydoc) {
  void publisher;
  void syncChannel;

  if (roomSyncListeners.has(roomId)) {
    return;
  }

  // Independent from the debounced-snapshot listener in yjsConnection.js —
  // this one is not chained off it and does not touch schedulePersist.
  const onUpdate = (update, origin) => {
    // TODO(core-logic): publish this update + this instance's ID to Redis on the room's channel.
    // Variables already in scope for this:
    //   update      - Uint8Array, the binary Yjs update payload to publish (this is the
    //                 "update" argument Yjs passes to Y.Doc's "update" event handler).
    //   origin      - the origin tag passed to whatever called Y.applyUpdate/the local
    //                 transaction; needed to skip re-publishing updates this instance applied
    //                 because they arrived from Redis in the first place (echo-loop prevention,
    //                 see subscribe-and-apply TODO below and the teardown TODO in stopRoomSync).
    //   roomId      - string, this room's ID; pass to syncChannel(roomId) for the channel name.
    //   INSTANCE_ID - string, this process's ID (from ../instanceId); goes in the SyncEnvelope
    //                 (see redis/channels.js) so receivers can recognize and drop their own echoes.
    void update;
    void origin;
    void roomId;
    void INSTANCE_ID;
  };

  roomSyncListeners.set(roomId, onUpdate);
  ydoc.on("update", onUpdate);

  // The subscribe-and-apply half is scaffolded separately in subscribeRoom()
  // below, and is deliberately NOT invoked from here. Calling it at this point
  // would pin the subscribe to startRoomSync's call site in the connection
  // flow, but WHERE the subscribe belongs relative to the Neon snapshot load
  // and the client's initial sync is an open ordering-guarantee decision — left
  // for whoever wires it in (see the TODO in yjsConnection.js).
}

/**
 * Scaffold for the subscribe-and-apply half of cross-instance sync: receive the
 * Yjs updates other instances publish on this room's channel and integrate them
 * into this instance's Y.Doc, so a client connected here sees an edit made by a
 * client on a different instance.
 *
 * Deliberately NOT called from startRoomSync or the connection flow yet: WHERE
 * the subscribe happens relative to the Neon snapshot load and the client's
 * initial sync is an ordering-guarantee decision left open (see the TODO in
 * yjsConnection.js). Teardown would pair with stopRoomSync.
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc  The shared per-room Y.Doc from getYDoc().
 */
function subscribeRoom(roomId, ydoc) {
  const channel = syncChannel(roomId);

  // Stub message handler for the subscription. `message` stands in for the
  // decoded SyncEnvelope ({ roomId, update, originInstanceId } — see
  // redis/channels.js); decoding the raw Redis payload back into that envelope
  // is part of the apply logic left unimplemented here.
  const onMessage = (message) => {
    // TODO(core-logic): check message.instanceId against local instance ID, skip if self-origin, otherwise Y.applyUpdate
    void message;
    void ydoc;
    void INSTANCE_ID;
  };

  // TODO(core-logic): subscribe the shared `subscriber` connection to `channel`
  // and route decoded messages on it to onMessage, exactly once per room
  // (getYDoc is shared across connections). This is the subscribe MECHANICS; the
  // subscribe TIMING is the separate open decision in yjsConnection.js.
  void channel;
  void onMessage;
  void subscriber;
}

/**
 * Stop mirroring a room once this instance no longer hosts it (last client of
 * the room disconnected). Detaches the "update" listener startRoomSync
 * attached; unsubscribing from Redis is still NOT implemented (see TODO
 * below).
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc
 */
function stopRoomSync(roomId, ydoc) {
  const onUpdate = roomSyncListeners.get(roomId);
  if (onUpdate) {
    ydoc.off("update", onUpdate);
    roomSyncListeners.delete(roomId);
  }

  // TODO(core-logic): echo-loop prevention (teardown half).
  // Problem: whatever mechanism distinguishes "update that originated here" from
  // "update that arrived from Redis" — an origin tag on Y.applyUpdate, a
  // recently-seen set keyed by envelope, comparing originInstanceId to
  // INSTANCE_ID, or similar — has to be established when sync starts and torn
  // down here, without leaking listeners or letting a late-arriving echo be
  // reprocessed after the room is gone. The choice of mechanism is what the two
  // TODOs above depend on, so it must be decided alongside them, not after.
}

module.exports = { startRoomSync, subscribeRoom, stopRoomSync };
