// The only place that speaks the Yjs sync protocol. Everything past
// `setupWSConnection` — sync steps, awareness, per-doc broadcast — is
// y-websocket's job; this server never interprets messages itself.
const { setupWSConnection } = require("y-websocket/bin/utils");
const { roomExists, claimRoom, scheduleEviction } = require("./rooms");

// Private-use close code for "this room is gone". The client keys its
// closed-room screen off this exact number, which is why the connection is
// accepted and *then* closed — a refused upgrade reaches the browser as an
// opaque error with no code attached.
const CLOSE_ROOM_NOT_FOUND = 4404;

function handleYjsConnection(ws, req) {
  // The doc name is the URL path, exactly how y-websocket's provider builds it.
  // Derived the same way here so the room we gate on is the room it names.
  const docName = req.url.slice(1).split("?")[0];

  // The gate has to live here, not only in the client's pre-check: connecting
  // is what creates a doc, so without this an old tab reconnecting would
  // resurrect a room destroyed while it was offline.
  if (!docName || !roomExists(docName)) {
    ws.close(CLOSE_ROOM_NOT_FOUND, "room-not-found");
    return;
  }

  claimRoom(docName);
  setupWSConnection(ws, req);

  // Registered after setupWSConnection so it runs after y-websocket has already
  // removed this connection — the eviction check sees the true remaining count.
  ws.on("close", () => scheduleEviction(docName));
}

module.exports = { handleYjsConnection, CLOSE_ROOM_NOT_FOUND };
