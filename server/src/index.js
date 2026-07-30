require("dotenv").config();

const http = require("http");
const { WebSocketServer } = require("ws");
const { handleYjsConnection, CLOSE_SERVICE_RESTART } = require("./sync/connection");
const {
  reserveRoom,
  roomExists,
  GRACE_MS,
  FLUSH_DEADLINE_MS,
  beginShutdown,
  flushAndDestroyAll,
  isShuttingDown,
} = require("./rooms/lifecycle");
const { createRateLimiter, clientKey } = require("./http/rateLimit");
const { intFromEnv } = require("./env");
const { getRoomLanguage, normalizeLanguage } = require("./rooms/state");
const db = require("./storage/db");

const PORT = process.env.PORT || 8080;

// 10 rooms/minute/IP. Only POST /rooms is limited; the other routes allocate nothing.
// Env-overridable like the snapshot pacing, because an end-to-end suite legitimately creates far
// more rooms per minute than a person does, and a 429 mid-suite looks like a product bug.
// INVARIANT: floor of 1 — a limit of 0 makes `recent.length >= 0` always true and no room could
// ever be created.
const ROOM_LIMIT = intFromEnv(process.env.ROOM_CREATE_LIMIT, 10, {
  min: 1,
  name: "ROOM_CREATE_LIMIT",
});
const ROOM_LIMIT_WINDOW_MS = intFromEnv(process.env.ROOM_CREATE_WINDOW_MS, 60_000, {
  min: 1,
  name: "ROOM_CREATE_WINDOW_MS",
});
const createRoomLimiter = createRateLimiter({ limit: ROOM_LIMIT, windowMs: ROOM_LIMIT_WINDOW_MS });

// INVARIANT: ws defaults to 100 MiB per message. Must stay well above the largest legitimate
// single update (one big paste, or a late joiner's sync-step-2 diff) — a client whose frame
// exceeds it is closed with 1009, reconnects, resends, and is closed again, forever.
const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;

// The frontend is always a different origin, and there is nothing to protect: these routes
// hand out random IDs and answer yes/no about one.
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

// INVARIANT: never build a URL from `req.headers.host` or from a whole request target. A
// malformed Host ("a b") and an absolute-form target ("GET http://[") both throw TypeError
// *inside* the request listener, which is an unauthenticated kill switch. The origin is unused
// here — only the path and the query are, and URLSearchParams never throws on any input.
function requestTarget(req) {
  const raw = typeof req.url === "string" ? req.url : "/";
  const q = raw.indexOf("?");
  return {
    path: q === -1 ? raw : raw.slice(0, q),
    query: new URLSearchParams(q === -1 ? "" : raw.slice(q + 1)),
  };
}

// INVARIANT: decodeURIComponent throws URIError on `%`, `%zz`, and on any escape decoding to a
// lone surrogate (`%ED%A0%80`). This route is anonymous, so an uncaught throw here kills every
// live room's unsaved snapshot with the process.
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function handleRequest(req, res) {
  const { path, query } = requestTarget(req);

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Cosmetic: opening the Railway URL in a browser otherwise reads like a dead deployment.
  if (req.method === "GET" && path === "/") {
    return json(res, 200, {
      service: "collabcode sync server",
      status: "ok",
      transport: "websocket (yjs sync protocol) on this same port",
      routes: ["GET /health", "POST /rooms", "GET /rooms/:roomId"],
    });
  }

  if (req.method === "GET" && path === "/health") {
    // 503 while draining so Railway stops routing here during the snapshot flush.
    if (isShuttingDown()) return json(res, 503, { ok: false, shuttingDown: true });
    return json(res, 200, { ok: true });
  }

  // INVARIANT: no body — a Content-Type would force a CORS preflight, hence `?language=`.
  // The value is narrowed by normalizeLanguage before it can reach dead_rooms.language.
  if (req.method === "POST" && path === "/rooms") {
    // INVARIANT: refuse while draining. The listener now stays open through the flush so
    // /health can answer 503, and flushAndDestroyAll iterates `docs`, never `reservations` —
    // so a room minted now would never be flushed and its creator would meet "this room has
    // closed" after the restart. The wording matters: createRoom() surfaces the server's own
    // sentence, and this must not read as "couldn't reach the sync server".
    if (isShuttingDown()) {
      res.setHeader("Retry-After", "5");
      return json(res, 503, {
        error: "The sync server is restarting. Try again in a few seconds.",
      });
    }

    // Also recorded as the room's snapshot-pacing key: this is the only moment a room and
    // an address are ever in the same place.
    const caller = clientKey(req);

    const limit = createRoomLimiter(caller);
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      return json(res, 429, {
        error: "You're creating rooms too quickly. Wait a moment and try again.",
      });
    }

    const language = normalizeLanguage(query.get("language"));

    const roomId = reserveRoom(caller, language);
    if (!roomId) {
      return json(res, 429, { error: "Too many rooms are being created. Try again shortly." });
    }
    console.log(`Room reserved: ${roomId} (${language})`);
    return json(res, 201, { roomId, language });
  }

  // Also hands back the room's language: that choice lives on the server, not in the shared
  // doc, so a peer arriving before the creator has synced still gets the right answer.
  if (req.method === "GET" && path.startsWith("/rooms/")) {
    const roomId = safeDecode(path.slice("/rooms/".length));
    // INVARIANT: always 200, and a malformed id is `exists:false` rather than a 400 — checkRoom
    // reads any non-ok response as *unreachable*, i.e. the retry screen for a room that never was.
    const exists = roomId !== null && roomId.length > 0 && roomExists(roomId);
    return json(res, 200, { exists, language: exists ? getRoomLanguage(roomId) : null });
  }

  return json(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  // INVARIANT: "this handler never throws" is enforced here rather than asserted. Every route
  // above is anonymous, so one uncaught throw is a remote kill switch.
  try {
    handleRequest(req, res);
  } catch (err) {
    // INVARIANT: never log req.url — it is attacker-controlled here and carries a Clerk token
    // on the WebSocket path. The message only.
    console.error("Request handler threw:", err.message);
    if (res.headersSent) res.end();
    else json(res, 500, { error: "Internal error" });
  }
});

// INVARIANT: maxPayload only became safe once connection.js registered a per-socket 'error'
// listener — a frame over the cap makes ws emit 'error' on the WebSocket, and an unhandled
// 'error' event throws. Setting this without that listener is a one-frame remote kill switch.
const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES });

wss.on("connection", handleYjsConnection);

server.on("error", (err) => console.error("HTTP server error:", err.message));
wss.on("error", (err) => console.error("WebSocket server error:", err.message));

server.listen(PORT, () => {
  console.log(`Yjs sync WebSocket server listening on port ${PORT}`);
  console.log(`Rooms are destroyed ${GRACE_MS}ms after the last client leaves`);

  // INVARIANT (documented in CLAUDE.md, now actually checked): the flush deadline must exceed
  // one Postgres connect attempt, or a shutdown gives up before the first write can land.
  if (db.isEnabled() && db.CONNECT_TIMEOUT_MS >= FLUSH_DEADLINE_MS) {
    console.warn(
      `DB_CONNECT_TIMEOUT_MS (${db.CONNECT_TIMEOUT_MS}) >= SNAPSHOT_FLUSH_MS ` +
        `(${FLUSH_DEADLINE_MS}); snapshots may be abandoned at shutdown.`
    );
  }
});

let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) {
    console.warn(`${signal} received again; exiting immediately`);
    process.exit(1);
  }
  shutdownStarted = true;

  // INVARIANT: the flag first, and server.close() LAST. Closing the listener before the flag was
  // set meant the platform got ECONNREFUSED instead of the 503 that /health's draining branch
  // exists to serve — that branch was unreachable on every SIGTERM.
  beginShutdown();
  console.log(`${signal} received; flushing dead-room snapshots (up to ${FLUSH_DEADLINE_MS}ms)`);

  await flushAndDestroyAll();

  // INVARIANT: after the rooms, so close handlers cannot perturb a flush in progress.
  for (const client of wss.clients) client.close(CLOSE_SERVICE_RESTART, "server-restart");

  server.close();
  // The listener stayed open through the flush, so a keep-alive connection could otherwise hold
  // the handle past the drain.
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();

  // INVARIANT: armed before db.close() — pool.end() can hang on an unresponsive Neon, and a
  // backstop created afterwards would never be reached.
  const backstop = setTimeout(() => process.exit(0), 2_000);
  if (typeof backstop.unref === "function") backstop.unref();

  await db.close();
  console.log("Shutdown complete");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// INVARIANT: a crash is not SIGTERM. Without this, an uncaught fault never runs
// flushAndDestroyAll(), so every live room's snapshot dies with the process — and the restart
// comes up with an empty registry, so nothing can ever retry the write.
let fatalHandled = false;

function fatal(kind, err) {
  if (fatalHandled) process.exit(1);
  fatalHandled = true;
  console.error(`${kind}; draining snapshots before exit:`, err?.stack ?? String(err));

  // exitCode rather than process.exit(1): exit() truncates pending stdout on Railway, and Node
  // still exits non-zero once the loop drains.
  process.exitCode = 1;
  if (shutdownStarted) return;
  shutdownStarted = true;

  // Unref'd: the pool sockets flushAndDestroyAll opens are what anchor the loop, so this only
  // fires if the drain itself wedges.
  const backstop = setTimeout(() => process.exit(1), FLUSH_DEADLINE_MS + 2_000);
  if (typeof backstop.unref === "function") backstop.unref();

  void flushAndDestroyAll()
    .catch((e) => console.error("Flush failed during fatal shutdown:", e.message))
    .then(() => db.close())
    .catch(() => {})
    .finally(() => {
      server.close();
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    });
}

process.on("uncaughtException", (err) => fatal("Uncaught exception", err));
process.on("unhandledRejection", (reason) =>
  fatal("Unhandled rejection", reason instanceof Error ? reason : new Error(String(reason)))
);
