const { setupWSConnection, docs } = require("y-websocket/bin/utils");
const { roomExists, claimRoom, scheduleEviction, isShuttingDown } = require("../rooms/lifecycle");
const { verifyClerkToken } = require("../auth/clerk");
const {
  beginMemberSession,
  endMemberSession,
  forgetConn,
  bindRoomObservers,
} = require("../rooms/state");

// INVARIANT: the client keys its closed-room screen off this exact code, so the socket is
// accepted and *then* closed. Keep in sync with web/src/hooks/useCollabRoom.ts.
const CLOSE_ROOM_NOT_FOUND = 4404;

// INVARIANT: a restart must not use 4404 — the client treats that as permanent and stops retrying.
const CLOSE_SERVICE_RESTART = 1012;

function handleYjsConnection(ws, req) {
  // INVARIANT: never log `req.url` — it carries a Clerk token. Log `docName`.
  const docName = req.url.slice(1).split("?")[0];

  if (isShuttingDown()) {
    ws.close(CLOSE_SERVICE_RESTART, "server-restart");
    return;
  }

  // INVARIANT: connecting is what creates a doc, so this gate must stay server-side.
  if (!docName || !roomExists(docName)) {
    ws.close(CLOSE_ROOM_NOT_FOUND, "room-not-found");
    return;
  }

  // Captured before the async verification, which must not be charged to connected time.
  const connectedAt = Date.now();

  claimRoom(docName);
  setupWSConnection(ws, req);
  bindRoomObservers(docName, docs.get(docName));

  // INVARIANT: registered after setupWSConnection, so eviction sees the true remaining count.
  // `forgetConn` runs for every socket, verified or not.
  ws.on("close", () => {
    forgetConn(docName, ws);
    scheduleEviction(docName);
  });

  // INVARIANT: token handling stays after the room gate — a probe loop must not buy a JWKS fetch each.
  let token = null;
  try {
    token = new URL(req.url, "http://localhost").searchParams.get("token");
  } catch {
    token = null;
  }
  if (!token) return;

  // INVARIANT: verification never refuses the socket; any failure just means no membership.
  verifyClerkToken(token).then((userId) => {
    if (!userId) return;
    // The room can die during a first-of-process JWKS fetch; recording a member would resurrect it.
    if (!docs.has(docName)) return;

    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
      // Closed while verifying, so the 'close' handler below will never be registered.
      beginMemberSession(docName, userId, connectedAt, ws);
      endMemberSession(docName, userId, Date.now(), ws);
      return;
    }

    beginMemberSession(docName, userId, connectedAt, ws);

    // INVARIANT: exactly one end per socket; a second decrement strands this user's refcount.
    let ended = false;
    ws.on("close", () => {
      if (ended) return;
      ended = true;
      endMemberSession(docName, userId, Date.now(), ws);
    });
  });
}

module.exports = { handleYjsConnection, CLOSE_ROOM_NOT_FOUND, CLOSE_SERVICE_RESTART };
