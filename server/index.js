require("dotenv").config();

const http = require("http");
const { WebSocketServer } = require("ws");
const { handleYjsConnection } = require("./yjsConnection");
const { reserveRoom, roomExists, GRACE_MS } = require("./rooms");
const { createRateLimiter, clientKey } = require("./rateLimit");

const PORT = process.env.PORT || 8080;

// 10 rooms/minute/IP. Creating a room is a deliberate act, so this sits far
// above real use while stopping a loop from exhausting the reservation ceiling
// in rooms.js. Only POST /rooms is limited; the other routes allocate nothing.
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
      service: "collab-code-editor sync server",
      status: "ok",
      transport: "websocket (yjs sync protocol) on this same port",
      routes: ["GET /health", "POST /rooms", "GET /rooms/:roomId"],
    });
  }

  if (req.method === "GET" && path === "/health") {
    // Also how the client tells "server is down" from "room is gone" — those
    // two must never produce the same message.
    return json(res, 200, { ok: true });
  }

  // Reserving IDs here is what gives "this room doesn't exist" a meaning: an ID
  // the server never handed out is refused at connect time. The body is empty
  // on purpose — no Content-Type keeps this a CORS simple request, no preflight.
  if (req.method === "POST" && path === "/rooms") {
    const limit = createRoomLimiter(clientKey(req));
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      return json(res, 429, {
        error: "You're creating rooms too quickly. Wait a moment and try again.",
      });
    }

    const roomId = reserveRoom();
    if (!roomId) {
      return json(res, 429, { error: "Too many rooms are being created. Try again shortly." });
    }
    console.log(`Room reserved: ${roomId}`);
    return json(res, 201, { roomId });
  }

  // Answers "is this room live right now", not "did it ever exist" — rooms are
  // destroyed once empty, so those are different questions.
  if (req.method === "GET" && path.startsWith("/rooms/")) {
    const roomId = decodeURIComponent(path.slice("/rooms/".length));
    return json(res, 200, { exists: Boolean(roomId) && roomExists(roomId) });
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
