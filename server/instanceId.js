// A stable identifier for THIS server process, generated once at startup.
//
// When multiple instances of this WS server run behind a load balancer, each
// needs a way to recognize its own messages coming back through Redis pub/sub
// so it can ignore them (see the echo-loop prevention TODO in redis/sync.js).
// A per-process UUID is the simplest thing that is unique across instances and
// survives for the life of the process without any coordination.
//
// Kept in its own module (rather than inside redis/) because it is a
// process-level identity that other subsystems may also want to reference, and
// so importing it never pulls in the Redis client as a side effect.
const crypto = require("crypto");

const INSTANCE_ID = crypto.randomUUID();

module.exports = { INSTANCE_ID };
