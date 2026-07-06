// Isolated from index.js on purpose: this module is the only place that speaks
// the Yjs sync protocol. Everything downstream of `setupWSConnection` (sync
// steps, awareness, per-doc broadcast) is handled by y-websocket itself — this
// server no longer echoes or interprets messages on its own.
const Y = require("yjs");
const { setupWSConnection, getYDoc } = require("y-websocket/bin/utils");
const { prisma } = require("./prismaClient");

async function handleYjsConnection(ws, req) {
  // docName defaults to the URL path (e.g. "/test-room" -> "test-room"),
  // which is exactly how y-websocket's WebsocketProvider builds its URL.
  const roomId = req.url.slice(1).split("?")[0];

  // setupWSConnection sends sync step 1 (and starts processing incoming
  // messages) synchronously, using whatever is already in the in-memory
  // Y.Doc. The Postgres round-trip below is async, so without pausing the
  // socket here, a fast client could sync against an empty doc before the
  // persisted state has been applied. Pausing/resuming brackets that gap.
  ws.pause();

  try {
    // Upsert (rather than find-then-create) so two clients racing to open
    // the same brand-new room can't both see "not found" and double-create.
    const room = await prisma.room.upsert({
      where: { id: roomId },
      update: {},
      create: { id: roomId },
    });

    if (room.ydocState) {
      Y.applyUpdate(getYDoc(roomId), new Uint8Array(room.ydocState));
    }
  } catch (err) {
    // Degrade to in-memory-only rather than leaving the client hanging if
    // Postgres is unreachable.
    console.error(`Failed to load room "${roomId}" from Postgres:`, err);
  }

  setupWSConnection(ws, req, { docName: roomId });
  ws.resume();
}

module.exports = { handleYjsConnection };
