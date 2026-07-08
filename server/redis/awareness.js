// Cross-instance Yjs AWARENESS (multi-cursor presence) relay wiring.
//
// SCAFFOLD ONLY: this module is the presence counterpart to redis/sync.js. Where
// sync.js relays durable document updates, this relays ephemeral awareness
// updates — cursor position, selection, display name/color — so a client on one
// server instance sees the live cursors of clients connected to a DIFFERENT
// instance. None of the core logic is implemented yet; the handlers below are
// intentionally empty and marked with TODO(core-logic).
//
// Deliberately structurally parallel to redis/sync.js (same start/subscribe/stop
// shape, same instance-ID + payload envelope) so the two relays read the same
// way. The differences are only:
//   - it attaches to `ydoc.awareness` (the y-protocols Awareness instance that
//     y-websocket's WSSharedDoc creates and broadcasts locally), not to `ydoc`;
//   - the payload is an awareness update (encodeAwarenessUpdate) applied with
//     applyAwarenessUpdate on the far side, not Y.applyUpdate;
//   - presence is ephemeral, which opens a cleanup question that has no analog
//     in document sync (stale cursors from a remote instance that dies — see the
//     TODO in subscribeRoomAwareness below).
//
// The intended flow, for context:
//   local awareness "update"  --publish-->  Redis  --deliver-->  other instances
//                                                                 --apply--> their Awareness
// so that presence converges across instances even though y-websocket only
// broadcasts awareness within a single process.
const awarenessProtocol = require("y-protocols/awareness");
const { publisher, subscriber } = require("./client");
const { awarenessChannel } = require("./channels");
const { INSTANCE_ID } = require("../instanceId");

// Per-room awareness "update" listener this module has attached, so a room that
// already has cross-instance presence relay wired up doesn't get a duplicate
// listener each time startRoomAwarenessSync is called again (getYDoc's
// WSSharedDoc — and therefore its single `.awareness` — is shared across every
// connection to the room, same reasoning as roomSyncListeners in redis/sync.js).
// Also lets stopRoomAwarenessSync remove the exact listener instance it added.
const roomAwarenessListeners = new Map(); // roomId -> awareness update listener function

/**
 * Begin mirroring a room's Yjs awareness (presence) updates across instances.
 *
 * Called once per room this instance starts hosting, alongside startRoomSync in
 * yjsConnection.js. The publish half — structurally the same as startRoomSync's
 * publish half, but over the awareness channel and payload.
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc  The shared per-room WSSharedDoc from getYDoc();
 *                                  its `.awareness` is the y-protocols Awareness
 *                                  instance y-websocket broadcasts locally.
 */
function startRoomAwarenessSync(roomId, ydoc) {
  void publisher;
  void awarenessChannel;
  void awarenessProtocol;

  if (roomAwarenessListeners.has(roomId)) {
    return;
  }

  const awareness = ydoc.awareness;

  // A SECOND, independent awareness "update" listener, separate from (and not
  // chained off) the one y-websocket's WSSharedDoc already uses to broadcast
  // presence to sockets on THIS instance. That local broadcast is untouched;
  // this listener only fans the same change out to Redis for OTHER instances.
  const onAwarenessUpdate = ({ added, updated, removed }, origin) => {
    // TODO(core-logic): publish this awareness update + this instance's ID to Redis on the room's awareness channel.
    // Variables already in scope for this:
    //   added/updated/removed - Arrays of client IDs that changed in this awareness event
    //                 (this is the first argument y-protocols passes to an Awareness
    //                 "update" handler). Their concatenation is the set of changed clients
    //                 to encode: awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
    //                 produces the Uint8Array payload to publish.
    //   origin      - the origin passed to whatever caused the change (a local socket, or the
    //                 origin tag from a remote applyAwarenessUpdate); needed to skip re-publishing
    //                 presence this instance applied because it arrived from Redis in the first
    //                 place (echo-loop prevention — same problem as in redis/sync.js, and the
    //                 same open decision, see the self-origin TODO in subscribeRoomAwareness).
    //   awareness   - the room's Awareness instance (ydoc.awareness); source for encodeAwarenessUpdate.
    //   roomId      - string, this room's ID; pass to awarenessChannel(roomId) for the channel name.
    //   INSTANCE_ID - string, this process's ID (from ../instanceId); goes in the AwarenessEnvelope
    //                 (see redis/channels.js) so receivers can recognize and drop their own echoes.
    void added;
    void updated;
    void removed;
    void origin;
    void awareness;
    void roomId;
    void INSTANCE_ID;
  };

  roomAwarenessListeners.set(roomId, onAwarenessUpdate);
  awareness.on("update", onAwarenessUpdate);

  // The subscribe-and-apply half is scaffolded separately in
  // subscribeRoomAwareness() below and, exactly like subscribeRoom in
  // redis/sync.js, is deliberately NOT invoked from here — its timing relative
  // to the connection flow is the same open ordering decision (see the TODO in
  // yjsConnection.js).
}

/**
 * Scaffold for the subscribe-and-apply half of cross-instance presence relay:
 * receive the awareness updates other instances publish on this room's awareness
 * channel and integrate them into this instance's Awareness, so a client
 * connected here sees the live cursor of a client on a different instance.
 *
 * Parallel to subscribeRoom in redis/sync.js: exported but deliberately NOT
 * called from startRoomAwarenessSync or the connection flow yet — WHERE the
 * subscribe happens relative to the Neon snapshot load and the client's initial
 * sync is the same open ordering decision (see the TODO in yjsConnection.js).
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc  The shared per-room WSSharedDoc from getYDoc().
 */
function subscribeRoomAwareness(roomId, ydoc) {
  const channel = awarenessChannel(roomId);
  const awareness = ydoc.awareness;

  // Stub message handler for the subscription. `message` stands in for the
  // decoded AwarenessEnvelope ({ roomId, update, originInstanceId } — see
  // redis/channels.js); decoding the raw Redis payload back into that envelope
  // is part of the apply logic left unimplemented here.
  const onMessage = (message) => {
    // TODO(core-logic): check message.instanceId against local instance ID, skip if self-origin, otherwise applyAwarenessUpdate
    // (awarenessProtocol.applyAwarenessUpdate(awareness, message.update, origin), with an origin
    // tag that the publish-side echo check above can recognize).
    void message;
    void awareness;
    void awarenessProtocol;
    void INSTANCE_ID;
  };

  // TODO(core-logic): subscribe the shared `subscriber` connection to `channel`
  // and route decoded messages on it to onMessage, exactly once per room
  // (WSSharedDoc/awareness is shared across connections). This is the subscribe
  // MECHANICS; the subscribe TIMING is the separate open decision in
  // yjsConnection.js.
  void channel;
  void onMessage;
  void subscriber;

  // TODO(core-logic): decide how to handle stale cursors when a remote instance dies without a clean disconnect (TTL? heartbeat? piggyback on existing awareness timeout?)
  // This is the presence-specific open decision with no analog in document sync.
  // Applied remote awareness states persist in this instance's Awareness until
  // something removes them. A clean remote disconnect propagates a "removed"
  // awareness update we relay and apply here — but an instance that crashes or
  // is network-partitioned publishes no such update, leaving ghost cursors for
  // its clients frozen on screen. y-protocols exposes the raw materials for
  // several strategies (awarenessProtocol.outdatedTimeout, removeAwarenessStates,
  // and the per-client timestamps applyAwarenessUpdate maintains), but which one
  // to use — and whether cleanup lives here on the apply side, in a separate
  // reaper, or is pushed to a Redis key TTL / heartbeat per instance — is left
  // open. NOTE it cannot live in stopRoomAwarenessSync: that only fires for
  // rooms THIS instance hosts when its own last client leaves, never when some
  // OTHER instance dies, which is exactly the case that strands these cursors.
}

/**
 * Stop mirroring a room's presence once this instance no longer hosts it (last
 * client of the room disconnected). Detaches the awareness "update" listener
 * startRoomAwarenessSync attached; unsubscribing from Redis is still NOT
 * implemented (see TODO below).
 *
 * @param {string} roomId
 * @param {import("yjs").Doc} ydoc
 */
function stopRoomAwarenessSync(roomId, ydoc) {
  const onAwarenessUpdate = roomAwarenessListeners.get(roomId);
  if (onAwarenessUpdate) {
    ydoc.awareness.off("update", onAwarenessUpdate);
    roomAwarenessListeners.delete(roomId);
  }

  // TODO(core-logic): echo-loop prevention (teardown half) + Redis unsubscribe.
  // Same shape as the teardown TODO in redis/sync.js's stopRoomSync: whatever
  // mechanism tells "presence that originated here" apart from "presence that
  // arrived from Redis" (an origin tag on applyAwarenessUpdate, comparing
  // originInstanceId to INSTANCE_ID, a recently-seen set, ...) is set up when the
  // relay starts and must be torn down here, along with unsubscribing the
  // `subscriber` from this room's awareness channel, without leaking listeners or
  // reprocessing a late echo after the room is gone. Distinct from the
  // stale-cursor decision above, which concerns OTHER instances dying, not this
  // instance's own teardown.
}

module.exports = {
  startRoomAwarenessSync,
  subscribeRoomAwareness,
  stopRoomAwarenessSync,
};
