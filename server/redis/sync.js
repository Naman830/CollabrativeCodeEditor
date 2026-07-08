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

/**
 * Begin mirroring a room's Yjs updates across instances.
 *
 * Called once per room this instance starts hosting (i.e. where a first client
 * connects). Intended to be invoked from the Yjs connection setup, but that
 * wiring is deliberately NOT added here yet.
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc  The shared per-room Y.Doc from getYDoc().
 */
function startRoomSync(roomId, ydoc) {
  void publisher;
  void subscriber;
  void syncChannel;
  void INSTANCE_ID;
  void roomId;
  void ydoc;

  // TODO(core-logic): publish-on-update.
  // Problem: a local edit updates only this instance's copy of the Y.Doc. Every
  // other instance hosting the same room needs to learn about that update.
  // What must be decided/handled: which document mutations to forward and which
  // to ignore (notably, updates this instance applied *because* they arrived
  // from Redis must not be re-published — that would loop); how to package the
  // binary update + roomId + INSTANCE_ID into a SyncEnvelope; and how to encode
  // that binary payload for a Redis publish.

  // TODO(core-logic): subscribe-and-apply.
  // Problem: updates published by other instances arrive on this room's sync
  // channel and must be integrated into this instance's Y.Doc so its connected
  // clients see the remote edit. What must be decided/handled: subscribing to
  // the correct per-room channel exactly once (getYDoc is shared across
  // connections); decoding the envelope back into a Uint8Array; and applying it
  // to the Y.Doc in a way that is distinguishable from a local edit so the
  // publish path above can tell them apart.
}

/**
 * Stop mirroring a room once this instance no longer hosts it (last client of
 * the room disconnected). Intended to unsubscribe and detach whatever
 * startRoomSync attached, but NOT implemented yet.
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc
 */
function stopRoomSync(roomId, ydoc) {
  void roomId;
  void ydoc;

  // TODO(core-logic): echo-loop prevention (teardown half).
  // Problem: whatever mechanism distinguishes "update that originated here" from
  // "update that arrived from Redis" — an origin tag on Y.applyUpdate, a
  // recently-seen set keyed by envelope, comparing originInstanceId to
  // INSTANCE_ID, or similar — has to be established when sync starts and torn
  // down here, without leaking listeners or letting a late-arriving echo be
  // reprocessed after the room is gone. The choice of mechanism is what the two
  // TODOs above depend on, so it must be decided alongside them, not after.
}

module.exports = { startRoomSync, stopRoomSync };
