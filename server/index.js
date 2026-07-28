require("dotenv").config();

const http = require("http");
const { WebSocketServer } = require("ws");
const { handleYjsConnection } = require("./yjsConnection");
const { reserveRoom, roomExists, GRACE_MS } = require("./rooms");
const { createRateLimiter, clientKey } = require("./rateLimit");

const PORT = process.env.PORT || 8080;

// 10 rooms/minute/IP. Creating a room is a deliberate act — click, name, enter —
// so this is far above real use while stopping a loop from burning through the
// reservation ceiling in rooms.js and denying everyone else a room. Only
// POST /rooms is limited: GET /rooms/:id and /health allocate nothing.
const createRoomLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

// The frontend is always a different origin (localhost:3000 -> localhost:8080 in
// dev, Vercel -> Railway in production), and there is nothing to protect here:
// these routes hand out random IDs and answer yes/no about one.
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// A hand-rolled router rather than Express: the whole HTTP surface is three
// routes, and the server has no framework dependency today.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/health") {
    // Also how the client tells "sync server is down" apart from "room is gone" —
    // those two must never produce the same message.
    return json(res, 200, { ok: true });
  }

  // Reserving an ID server-side is what gives "this room doesn't exist" a
  // meaning: a room the server never handed out is refused at connect time.
  // The request body is deliberately empty — no Content-Type means this stays a
  // CORS *simple* request and skips the preflight round trip.
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

  // Answers "is this room live right now", not "has anyone ever visited it" —
  // rooms are destroyed once empty, so the two are genuinely different questions.
  if (req.method === "GET" && path.startsWith("/rooms/")) {
    const roomId = decodeURIComponent(path.slice("/rooms/".length));
    return json(res, 200, { exists: Boolean(roomId) && roomExists(roomId) });
  }

  return json(res, 404, { error: "Not found" });
});

// Shares the port with the HTTP routes above: Railway exposes one port per
// service, and the frontend derives the HTTP base by swapping the ws:// scheme
// on NEXT_PUBLIC_WS_URL. Upgrade requests never reach the request handler.
const wss = new WebSocketServer({ server });

wss.on("connection", handleYjsConnection);

server.listen(PORT, () => {
  console.log(`Yjs sync WebSocket server listening on port ${PORT}`);
  console.log(`Rooms are destroyed ${GRACE_MS}ms after the last client leaves`);
});
