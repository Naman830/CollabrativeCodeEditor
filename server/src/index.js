require("dotenv").config();

const http = require("http");
const { WebSocketServer } = require("ws");
const { handleYjsConnection, CLOSE_SERVICE_RESTART } = require("./sync/connection");
const {
  reserveRoom,
  roomExists,
  GRACE_MS,
  FLUSH_DEADLINE_MS,
  flushAndDestroyAll,
  isShuttingDown,
} = require("./rooms/lifecycle");
const { createRateLimiter, clientKey } = require("./http/rateLimit");
const { getRoomLanguage, normalizeLanguage } = require("./rooms/state");
const db = require("./storage/db");

const PORT = process.env.PORT || 8080;

// 10 rooms/minute/IP. Only POST /rooms is limited; the other routes allocate nothing.
const createRoomLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

// The frontend is always a different origin, and there is nothing to protect: these routes
// hand out random IDs and answer yes/no about one.
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

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

    const language = normalizeLanguage(url.searchParams.get("language"));

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
    const roomId = decodeURIComponent(path.slice("/rooms/".length));
    const exists = Boolean(roomId) && roomExists(roomId);
    // INVARIANT: always 200 — existence is the `exists` field; non-ok means unreachable.
    return json(res, 200, { exists, language: exists ? getRoomLanguage(roomId) : null });
  }

  return json(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ server });

wss.on("connection", handleYjsConnection);

server.listen(PORT, () => {
  console.log(`Yjs sync WebSocket server listening on port ${PORT}`);
  console.log(`Rooms are destroyed ${GRACE_MS}ms after the last client leaves`);
});

let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) {
    console.warn(`${signal} received again; exiting immediately`);
    process.exit(1);
  }
  shutdownStarted = true;
  console.log(`${signal} received; flushing dead-room snapshots (up to ${FLUSH_DEADLINE_MS}ms)`);

  server.close();
  await flushAndDestroyAll();

  // INVARIANT: after the rooms, so close handlers cannot perturb a flush in progress.
  for (const client of wss.clients) client.close(CLOSE_SERVICE_RESTART, "server-restart");

  // INVARIANT: armed before db.close() — pool.end() can hang on an unresponsive Neon, and a
  // backstop created afterwards would never be reached.
  const backstop = setTimeout(() => process.exit(0), 2_000);
  if (typeof backstop.unref === "function") backstop.unref();

  await db.close();
  console.log("Shutdown complete");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
