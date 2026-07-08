// Redis connections for cross-instance Yjs document sync.
//
// ---------------------------------------------------------------------------
// Required environment variables
// ---------------------------------------------------------------------------
//   REDIS_URL   Full `rediss://default:<password>@<host>:<port>` connection
//               string for the Upstash database. Copy the "TCP" / ioredis
//               endpoint from the Upstash console (NOT the REST endpoint).
//               The `rediss://` scheme enables TLS, which Upstash requires.
//
// Optional:
//   REDIS_TLS_REJECT_UNAUTHORIZED
//               Set to "false" only to bypass TLS cert verification in local
//               testing. Leave unset in production.
// ---------------------------------------------------------------------------
//
// Why ioredis and not Upstash's REST API (@upstash/redis):
//   The REST API is stateless request/response — great for serverless and
//   one-shot commands, but it cannot hold a long-lived SUBSCRIBE. Cross-instance
//   sync depends on each server keeping an open subscription and receiving
//   messages pushed by Redis for the life of the process. That requires a
//   persistent TCP connection, which ioredis speaks natively. The trade-off is
//   that we now hold real sockets open (one per role below) instead of relying
//   on stateless HTTP, so connection lifecycle and reconnection are our concern.
//
// Why two connections:
//   Once a Redis connection issues SUBSCRIBE it enters "subscriber mode" and
//   may only run (un)subscribe commands — it can no longer PUBLISH. So pub/sub
//   fan-out needs a dedicated subscriber connection plus a separate connection
//   for publishing (and any other commands).
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL;

// Fail loud at startup rather than on the first publish/subscribe attempt: a
// missing URL is a deployment misconfiguration, not a runtime condition to
// degrade past.
if (!REDIS_URL) {
  throw new Error(
    "REDIS_URL is not set. See the comment block in server/redis/client.js " +
      "for the required environment variables."
  );
}

const connectionOptions = {
  // Upstash requires TLS; `rediss://` in the URL turns it on. This flag only
  // exists as a local-testing escape hatch and defaults to strict verification.
  tls:
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED === "false"
      ? { rejectUnauthorized: false }
      : undefined,
};

// Publisher: also used for any non-subscribe commands.
const publisher = new Redis(REDIS_URL, connectionOptions);

// Subscriber: kept separate because it will enter subscriber mode (see above).
const subscriber = new Redis(REDIS_URL, connectionOptions);

for (const [role, conn] of [
  ["publisher", publisher],
  ["subscriber", subscriber],
]) {
  conn.on("error", (err) => {
    // ioredis reconnects on its own; log rather than crash so a transient Redis
    // blip degrades cross-instance sync without taking the WS server down.
    console.error(`Redis ${role} connection error:`, err);
  });
}

module.exports = { publisher, subscriber };
