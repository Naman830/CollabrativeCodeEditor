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

// 10 rooms/minute/IP. Creating a room is a deliberate act, so this sits far
// above real use while stopping a loop from exhausting the reservation ceiling
// in rooms/lifecycle.js. Only POST /rooms is limited; the other routes allocate nothing.
const createRoomLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

// The frontend is always a different origin (localhost:3000 -> :8080 in dev,
// Vercel -> Railway in production), and there is nothing to protect: these
// routes hand out random IDs and answer yes/no about one.
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Hand-rolled rather than Express: the whole HTTP surface is four routes.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Purely cosmetic. Opening the Railway URL in a browser used to return the
  // catch-all 404, which reads like a dead deployment even though the service
  // is fine — this host is only ever used as wss:// plus the routes below.
  if (req.method === "GET" && path === "/") {
    return json(res, 200, {
      service: "collabcode sync server",
      status: "ok",
      transport: "websocket (yjs sync protocol) on this same port",
      routes: ["GET /health", "POST /rooms", "GET /rooms/:roomId"],
    });
  }

  if (req.method === "GET" && path === "/health") {
    // Also how the client tells "server is down" from "room is gone" — those
    // two must never produce the same message.
    //
    // 503 while draining so Railway stops routing to this container during the
    // snapshot flush (railway.json already points its healthcheck here).
    if (isShuttingDown()) return json(res, 503, { ok: false, shuttingDown: true });
    return json(res, 200, { ok: true });
  }

  // Reserving IDs here is what gives "this room doesn't exist" a meaning: an ID
  // the server never handed out is refused at connect time. The body is still
  // empty on purpose — no Content-Type keeps this a CORS simple request, no
  // preflight — which is why §10.1's room language arrives as `?language=`
  // rather than as JSON. It is narrowed by `normalizeLanguage`, so an anonymous
  // caller cannot put an arbitrary string on the path to `dead_rooms.language`.
  if (req.method === "POST" && path === "/rooms") {
    // Derived once and used twice: it limits creation here, and it is recorded
    // on the room as the pacing key for that room's eventual snapshot write
    // (task 7.5). This request is the only point at which a room and an address
    // are ever in the same place — by the time the room dies there is no request
    // and no socket left to ask.
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

  // Answers "is this room live right now", not "did it ever exist" — rooms are
  // destroyed once empty, so those are different questions.
  //
  // Also hands back the room's language (§10.1). This is the only way someone
  // who was sent a link learns which language the room was created in: the
  // choice lives on the server, deliberately not in the shared doc, so a peer
  // arriving before the creator has synced still gets the right answer.
  if (req.method === "GET" && path.startsWith("/rooms/")) {
    const roomId = decodeURIComponent(path.slice("/rooms/".length));
    const exists = Boolean(roomId) && roomExists(roomId);
    // Still always HTTP 200 — existence is the `exists` field, and `checkRoom`
    // reads a non-ok response as *unreachable*, never as *missing*.
    return json(res, 200, { exists, language: exists ? getRoomLanguage(roomId) : null });
  }

  return json(res, 404, { error: "Not found" });
});

// Shares the port with the routes above: Railway exposes one port per service,
// and the frontend derives the HTTP base by swapping the ws:// scheme. Upgrade
// requests never reach the request handler.
const wss = new WebSocketServer({ server });

wss.on("connection", handleYjsConnection);

server.listen(PORT, () => {
  console.log(`Yjs sync WebSocket server listening on port ${PORT}`);
  console.log(`Rooms are destroyed ${GRACE_MS}ms after the last client leaves`);
});

// Without this, a Railway redeploy silently loses every dead-room snapshot: the
// eviction timers in rooms/lifecycle.js are unref'd, so a queued eviction never fires on
// SIGTERM, and a room someone was actively working in is never even queued.
// Invisible locally, guaranteed in production.
let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) {
    // A second signal means "stop waiting". Honour it.
    console.warn(`${signal} received again; exiting immediately`);
    process.exit(1);
  }
  shutdownStarted = true;
  console.log(`${signal} received; flushing dead-room snapshots (up to ${FLUSH_DEADLINE_MS}ms)`);

  server.close();
  await flushAndDestroyAll();

  // After the rooms, so their close handlers cannot perturb a flush in progress.
  for (const client of wss.clients) client.close(CLOSE_SERVICE_RESTART, "server-restart");

  // Armed BEFORE `db.close()`, not after. `pool.end()` waits for every
  // checked-out client to be released, and the pool sets no `statement_timeout`
  // or `query_timeout` — so a query wedged against an unresponsive Neon hangs
  // this await indefinitely. A backstop created afterwards would never be
  // reached, leaving nothing but the platform's SIGKILL to end the process.
  //
  // Destroying every doc cleared each Awareness's 3s `_checkInterval` — which is
  // NOT unref'd, and is the reason this process never exits on its own — plus
  // every per-connection ping timer, so on a healthy shutdown the event loop
  // drains and Node exits naturally with stdout flushed. `process.exit`
  // truncates pending pipe writes on Railway, so it stays the backstop.
  const backstop = setTimeout(() => process.exit(0), 2_000);
  if (typeof backstop.unref === "function") backstop.unref();

  await db.close();
  console.log("Shutdown complete");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
