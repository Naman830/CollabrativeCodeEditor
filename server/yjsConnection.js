// Isolated from index.js on purpose: this module is the only place that speaks
// the Yjs sync protocol. Everything downstream of `setupWSConnection` (sync
// steps, awareness, per-doc broadcast) is handled by y-websocket itself — this
// server no longer echoes or interprets messages on its own.
const { setupWSConnection } = require("y-websocket/bin/utils");
const { roomExists, claimRoom, scheduleEviction } = require("./rooms");

// Private-use WebSocket close code for "this room is gone". The client keys its
// closed-room screen off this exact number (see CodeEditor's connection-close
// handler), which is why the connection is accepted and *then* closed rather
// than having the HTTP upgrade refused: a refused upgrade reaches the browser as
// an opaque error with no code attached.
const CLOSE_ROOM_NOT_FOUND = 4404;

function handleYjsConnection(ws, req) {
  // docName defaults to the URL path (e.g. "/test-room" -> "test-room"),
  // which is exactly how y-websocket's WebsocketProvider builds its URL. Derived
  // identically here so the room we gate on is the room the doc gets named.
  const docName = req.url.slice(1).split("?")[0];

  // The gate has to live here, not only in the client's HTTP pre-check:
  // `setupWSConnection` creates the doc via `map.setIfUndefined`, so *connecting
  // to a room is what creates it*. Without this check an old tab reconnecting
  // would silently resurrect a room that was destroyed while it was offline.
  if (!docName || !roomExists(docName)) {
    ws.close(CLOSE_ROOM_NOT_FOUND, "room-not-found");
    return;
  }

  claimRoom(docName);
  setupWSConnection(ws, req);

  // Registered after setupWSConnection, so it runs after y-websocket's own close
  // handler has already removed this connection from `doc.conns` — the eviction
  // check therefore sees the true remaining count.
  ws.on("close", () => scheduleEviction(docName));
}

module.exports = { handleYjsConnection, CLOSE_ROOM_NOT_FOUND };
