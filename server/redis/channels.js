// Channel naming scheme and message envelope for cross-instance Yjs sync.
//
// Constants and shapes only — no publish/subscribe behaviour lives here.

// Every room gets its own pub/sub channel so an instance only receives traffic
// for rooms it is actually hosting connections for, rather than a single
// firehose it has to filter. The `{roomId}` segment is interpolated by
// syncChannel() below.
//
// NOTE: roomId comes from the client-controlled URL path (see
// yjsConnection.js), so it can contain ":" and would otherwise let a client
// address channels for other rooms. Sanitization of roomId is the concern of
// whoever wires up publish/subscribe — flagged in redis/sync.js.
const SYNC_CHANNEL_PREFIX = "room:";
const SYNC_CHANNEL_SUFFIX = ":sync";

/**
 * Build the pub/sub channel name for a room's Yjs updates.
 * @param {string} roomId
 * @returns {string} e.g. "room:abc123:sync"
 */
function syncChannel(roomId) {
  return `${SYNC_CHANNEL_PREFIX}${roomId}${SYNC_CHANNEL_SUFFIX}`;
}

// Awareness (multi-cursor presence) rides a SEPARATE per-room channel from the
// sync channel above, mirroring how the Yjs protocol itself keeps awareness and
// document updates on distinct message types (see the "Presence" section in the
// root README). Kept apart so a subscriber can, if it ever wants to, take
// document updates without the (far chattier, ephemeral) cursor traffic — and
// so the two envelopes below can evolve independently.
//
// Same roomId-is-client-controlled caveat as SYNC_CHANNEL_PREFIX applies:
// sanitization is the concern of whoever wires up publish/subscribe — flagged in
// redis/awareness.js.
const AWARENESS_CHANNEL_PREFIX = "room:";
const AWARENESS_CHANNEL_SUFFIX = ":awareness";

/**
 * Build the pub/sub channel name for a room's Yjs awareness (presence) updates.
 * @param {string} roomId
 * @returns {string} e.g. "room:abc123:awareness"
 */
function awarenessChannel(roomId) {
  return `${AWARENESS_CHANNEL_PREFIX}${roomId}${AWARENESS_CHANNEL_SUFFIX}`;
}

/**
 * The envelope published on a room's sync channel. Carries a single Yjs update
 * from the instance that produced it to every other instance hosting the same
 * room.
 *
 * The Yjs update is binary. Redis pub/sub payloads are strings/Buffers, so the
 * transport encoding of `update` (raw Buffer vs. base64-in-JSON, etc.) is a
 * decision for the publish/subscribe implementation — flagged in redis/sync.js.
 *
 * @typedef {Object} SyncEnvelope
 * @property {string} roomId        Room the update belongs to.
 * @property {Uint8Array} update    Binary Yjs document update (Y.encodeStateAsUpdate / update event payload).
 * @property {string} originInstanceId  INSTANCE_ID of the process that produced
 *                                       this update; used by receivers to drop
 *                                       their own echoed messages.
 */

/**
 * The envelope published on a room's awareness channel. Carries a single Yjs
 * awareness update (one or more clients' presence state) from the instance that
 * produced it to every other instance hosting the same room.
 *
 * Structurally identical to SyncEnvelope on purpose — same instance-ID + payload
 * shape — so the publish/subscribe plumbing can be written once per pattern. The
 * ONLY difference is what `update` encodes: here it's an awareness update
 * (awarenessProtocol.encodeAwarenessUpdate over the changed client IDs), applied
 * on the far side with awarenessProtocol.applyAwarenessUpdate rather than
 * Y.applyUpdate. Same binary-over-a-string-transport encoding decision as
 * SyncEnvelope, likewise left to the implementation — flagged in
 * redis/awareness.js.
 *
 * @typedef {Object} AwarenessEnvelope
 * @property {string} roomId        Room the presence update belongs to.
 * @property {Uint8Array} update    Binary Yjs awareness update (awarenessProtocol.encodeAwarenessUpdate).
 * @property {string} originInstanceId  INSTANCE_ID of the process that produced
 *                                       this update; used by receivers to drop
 *                                       their own echoed messages.
 */

module.exports = {
  SYNC_CHANNEL_PREFIX,
  SYNC_CHANNEL_SUFFIX,
  syncChannel,
  AWARENESS_CHANNEL_PREFIX,
  AWARENESS_CHANNEL_SUFFIX,
  awarenessChannel,
};
