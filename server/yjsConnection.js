// The only place that speaks the Yjs sync protocol. Everything past
// `setupWSConnection` — sync steps, awareness, per-doc broadcast — is
// y-websocket's job; this server never interprets messages itself.
const { setupWSConnection, docs } = require("y-websocket/bin/utils");
const { roomExists, claimRoom, scheduleEviction, isShuttingDown } = require("./rooms");
const { verifyClerkToken } = require("./clerkAuth");
const {
  beginMemberSession,
  endMemberSession,
  forgetConn,
  bindRoomObservers,
} = require("./roomState");

// Private-use close code for "this room is gone". The client keys its
// closed-room screen off this exact number, which is why the connection is
// accepted and *then* closed — a refused upgrade reaches the browser as an
// opaque error with no code attached.
const CLOSE_ROOM_NOT_FOUND = 4404;

// Standard "Service Restart". Deliberately NOT 4404: the client treats that as
// permanent, calls `provider.disconnect()` and shows the closed screen forever.
// A redeploy wants the opposite — every other close code keeps y-websocket
// retrying, which is exactly right when a new container is seconds away.
const CLOSE_SERVICE_RESTART = 1012;

function handleYjsConnection(ws, req) {
  // The doc name is the URL path, exactly how y-websocket's provider builds it.
  // Derived the same way here so the room we gate on is the room it names — and
  // the `split("?")` is why task 7.3's `?token=` needed no change to this line.
  //
  // NEVER log `req.url`. Since 7.3 it carries a Clerk session token; log
  // `docName` instead.
  const docName = req.url.slice(1).split("?")[0];

  if (isShuttingDown()) {
    ws.close(CLOSE_SERVICE_RESTART, "server-restart");
    return;
  }

  // The gate has to live here, not only in the client's pre-check: connecting
  // is what creates a doc, so without this an old tab reconnecting would
  // resurrect a room destroyed while it was offline.
  if (!docName || !roomExists(docName)) {
    ws.close(CLOSE_ROOM_NOT_FOUND, "room-not-found");
    return;
  }

  // Captured before verification, which is asynchronous: the round trip must not
  // be charged against the user's connected time.
  const connectedAt = Date.now();

  claimRoom(docName);
  setupWSConnection(ws, req);
  bindRoomObservers(docName, docs.get(docName));

  // Registered after setupWSConnection so it runs after y-websocket has already
  // removed this connection — the eviction check sees the true remaining count.
  //
  // `forgetConn` runs for every socket, not just verified ones: a guest's edits
  // sit unattributed by design, and a room outlives many joins and leaves.
  ws.on("close", () => {
    forgetConn(docName, ws);
    scheduleEviction(docName);
  });

  // Only now, after the room gate has passed. A probe loop against dead room IDs
  // must not cost a JWKS round trip each — the WebSocket path is not covered by
  // POST /rooms' rate limiter — and there would be no room to record a member on
  // anyway.
  let token = null;
  try {
    token = new URL(req.url, "http://localhost").searchParams.get("token");
  } catch {
    token = null;
  }
  if (!token) return;

  // Verification never gates the socket: it is already open and syncing. A
  // guest, an expired token, an unset CLERK_SECRET_KEY and a Clerk outage all
  // land in the same place — no membership recorded, room otherwise untouched.
  verifyClerkToken(token).then((userId) => {
    if (!userId) return;
    // The room can be destroyed while a first-of-process JWKS fetch is in
    // flight; recording a member on it would resurrect state for a dead room.
    if (!docs.has(docName)) return;

    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
      // Closed while we were verifying. Record the completed session directly,
      // since the 'close' handler below will never be registered.
      beginMemberSession(docName, userId, connectedAt, ws);
      endMemberSession(docName, userId, Date.now(), ws);
      return;
    }

    beginMemberSession(docName, userId, connectedAt, ws);

    // One end per socket, guaranteed. A second decrement would strand this
    // user's refcount below zero and stop their time accruing for the rest of
    // the room's life — silent, and invisible until a snapshot is missing.
    let ended = false;
    ws.on("close", () => {
      if (ended) return;
      ended = true;
      endMemberSession(docName, userId, Date.now(), ws);
    });
  });
}

module.exports = { handleYjsConnection, CLOSE_ROOM_NOT_FOUND, CLOSE_SERVICE_RESTART };
