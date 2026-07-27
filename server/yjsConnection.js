// Isolated from index.js on purpose: this module is the only place that speaks
// the Yjs sync protocol. Everything downstream of `setupWSConnection` (sync
// steps, awareness, per-doc broadcast) is handled by y-websocket itself — this
// server no longer echoes or interprets messages on its own.
const Y = require("yjs");
const encoding = require("lib0/encoding");
const { setupWSConnection, getYDoc } = require("y-websocket/bin/utils");
const { prisma } = require("./prismaClient");
const { INSTANCE_ID } = require("./instanceId");
const { startRoomSync, stopRoomSync } = require("./redis/sync");
const {
  startRoomAwarenessSync,
  stopRoomAwarenessSync,
} = require("./redis/awareness");

// A one-off handshake message, not part of the Yjs sync protocol above: lets a
// client show which physical server/ instance it landed on (useful while
// testing the Redis cross-instance relay via `dev:cluster`). Message type 42
// is deliberately outside y-websocket's own reserved range (sync=0,
// awareness=1, auth=2, queryAwareness=3) so it round-trips untouched through
// setupWSConnection's dispatcher — the client registers its own handler for
// type 42 (see CodeEditor.tsx) instead of this server interpreting anything.
const MESSAGE_INSTANCE_HELLO = 42;

function sendInstanceHello(ws) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_INSTANCE_HELLO);
  encoding.writeVarString(encoder, INSTANCE_ID);
  ws.send(encoding.toUint8Array(encoder));
}

// 4s of quiet time before a room's doc is flushed to Postgres. See README.md
// ("Persistence debounce") for the reasoning behind this value.
const PERSIST_DEBOUNCE_MS = 4000;

// The room id arrives as the WebSocket URL's path segment, which is entirely
// caller-controlled: only the browser client happens to encodeURIComponent it
// (CodeEditor.tsx), and any direct `ws` client can send a raw path. Validating
// here — the single boundary where the id enters this process — is what keeps
// four otherwise-separate problems closed at once:
//
//   1. `roomId` is the Postgres primary key upserted in handleYjsConnection,
//      so an unbounded charset means unbounded row creation from
//      unauthenticated traffic (connect to /a1, /a2, /a3 ... forever).
//   2. It keys y-websocket's `docs` map, which this server never evicts, so
//      the same loop grows process memory without bound.
//   3. redis/channels.js builds `room:${roomId}:sync` by raw interpolation
//      (see its own comments at channels.js:11-13) — an id containing ":"
//      could address another room's channel once pub/sub is actually wired.
//   4. It keeps one canonical spelling of the id. Note this pattern is a
//      subset of encodeURIComponent's unreserved set, so for every id that
//      passes, encoding is a no-op and the decode below cannot change an
//      already-persisted key. No migration is needed.
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// 1008 = "policy violation": the server understood the request and is
// refusing it on validation grounds.
const CLOSE_POLICY_VIOLATION = 1008;

// Returns the canonical room id, or null if the path segment isn't one we're
// willing to accept.
function parseRoomId(url) {
  const segment = url.slice(1).split("?")[0];

  let roomId;
  try {
    roomId = decodeURIComponent(segment);
  } catch {
    // A malformed percent-escape ("%zz") makes decodeURIComponent throw
    // URIError rather than pass the input through.
    return null;
  }

  return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
}

// Per-room debounce timers, so an idle room doesn't get its save delayed by
// activity in a different room (and a busy room doesn't write on every
// keystroke).
const saveTimers = new Map(); // roomId -> Timeout

// getYDoc returns the same shared Y.Doc instance for every connection to a
// given room, so we guard against attaching a duplicate "update" listener
// each time a new client connects.
const persistedRooms = new Set(); // roomId

async function persistRoom(roomId, ydoc) {
  const update = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  await prisma.room.update({
    where: { id: roomId },
    data: { ydocState: update },
  });
}

function schedulePersist(roomId, ydoc) {
  clearTimeout(saveTimers.get(roomId));
  saveTimers.set(
    roomId,
    setTimeout(async () => {
      saveTimers.delete(roomId);
      try {
        await persistRoom(roomId, ydoc);
      } catch (err) {
        console.error(`Failed to persist room "${roomId}" to Postgres:`, err);
      }
    }, PERSIST_DEBOUNCE_MS)
  );
}

// Called when a room's last WebSocket client disconnects. Cancels whatever
// debounce timer is pending and writes immediately, so a room that goes
// idle isn't left waiting out PERSIST_DEBOUNCE_MS with no client left to
// generate the update that would otherwise trigger that write.
function flushPersist(roomId, ydoc) {
  clearTimeout(saveTimers.get(roomId));
  saveTimers.delete(roomId);
  persistRoom(roomId, ydoc).catch((err) => {
    console.error(
      `Failed to flush room "${roomId}" to Postgres on last disconnect:`,
      err
    );
  });
}

async function handleYjsConnection(ws, req) {
  // docName defaults to the URL path (e.g. "/test-room" -> "test-room"),
  // which is exactly how y-websocket's WebsocketProvider builds its URL.
  // Rejected before anything else happens — in particular before the upsert
  // below can create a row for it. See ROOM_ID_PATTERN for why this matters.
  const roomId = parseRoomId(req.url);
  if (roomId === null) {
    ws.close(CLOSE_POLICY_VIOLATION, "invalid room id");
    return;
  }

  // Fires before the Postgres round-trip below (which can take seconds on a
  // cold Neon connection) since it depends on nothing but the connection
  // itself — waiting behind room hydration would leave the client's status
  // pill showing "Connected" with no instance badge for however long that
  // round-trip takes.
  sendInstanceHello(ws);

  // setupWSConnection sends sync step 1 (and starts processing incoming
  // messages) synchronously, using whatever is already in the in-memory
  // Y.Doc. The Postgres round-trip below is async, so without pausing the
  // socket here, a fast client could sync against an empty doc before the
  // persisted state has been applied. Pausing/resuming brackets that gap.
  ws.pause();

  const ydoc = getYDoc(roomId);

  // Whether this connection actually got the room's persisted state into the
  // in-memory doc. Gates every write below — see the comment on the guard.
  let hydrated = false;

  try {
    // Upsert (rather than find-then-create) so two clients racing to open
    // the same brand-new room can't both see "not found" and double-create.
    const room = await prisma.room.upsert({
      where: { id: roomId },
      update: {},
      create: { id: roomId },
    });

    if (room.ydocState) {
      Y.applyUpdate(ydoc, new Uint8Array(room.ydocState));
    }

    hydrated = true;
  } catch (err) {
    // Degrade to in-memory-only rather than leaving the client hanging if
    // Postgres is unreachable: collaboration between the clients currently
    // connected still works, it just isn't durable.
    console.error(`Failed to load room "${roomId}" from Postgres:`, err);
  }

  // Attached after the initial load applies above, so restoring persisted
  // state on connect doesn't itself trigger a redundant save.
  //
  // The `hydrated` gate is load-bearing and NOT a stylistic guard. Without it
  // a failed load was silently destructive: the catch above leaves `ydoc`
  // empty, the listener would attach anyway, and the client's first keystroke
  // schedules a persist that writes Y.encodeStateAsUpdate(<empty doc>) over a
  // perfectly good ydocState column. One transient Neon blip on the first
  // connection to a room permanently erased it, and there is no backup.
  //
  // Gating on hydration rather than poisoning the room outright is what makes
  // this recoverable: `persistedRooms` membership means "this doc is known to
  // reflect what's in Postgres", so a later connection that loads
  // successfully applies the snapshot on top (a CRDT merge with whatever was
  // typed in the meantime — no edits lost) and attaches the listener then.
  if (hydrated && !persistedRooms.has(roomId)) {
    persistedRooms.add(roomId);
    ydoc.on("update", () => schedulePersist(roomId, ydoc));
  }

  // Independent of the persistence listener above: wires up the (not yet
  // implemented) cross-instance Redis sync. startRoomSync attaches its own
  // separate "update" listener and guards against duplicate attachment
  // itself, so it's safe to call on every connection to this room.
  startRoomSync(roomId, ydoc);

  // Presence counterpart to startRoomSync: relays this room's awareness
  // (multi-cursor) updates to other instances. Attaches its own listener to
  // ydoc.awareness, guards against duplicate attachment itself, and is
  // independent of both the persistence and doc-sync listeners above — so it's
  // likewise safe to call on every connection to this room. Its subscribe-and-
  // apply half (subscribeRoomAwareness) is scaffolded but, exactly like
  // subscribeRoom below, deliberately left un-wired pending the same ordering
  // decision.
  startRoomAwarenessSync(roomId, ydoc);

  // The subscribe-and-apply half of cross-instance sync — receiving the updates
  // OTHER instances publish for this room and applying them to this ydoc — is
  // scaffolded as subscribeRoom(roomId, ydoc) in redis/sync.js, but is NOT
  // wired in here. It sits between two boundaries that both live in this
  // function: the snapshot load from Neon (the prisma.room.upsert +
  // Y.applyUpdate block above) and the client's initial sync (setupWSConnection,
  // immediately below). Subscribing before vs. after each boundary changes what
  // a freshly-connected client can observe, so the placement is a correctness
  // decision, not a stylistic one — hence left open rather than picked here.
  //
  // TODO(core-logic): decide exactly where this subscribe call goes relative to snapshot-load-from-Neon and client-sync, and justify the ordering

  setupWSConnection(ws, req, { docName: roomId });

  // setupWSConnection already registered its own "close" handler, which
  // removes this connection from ydoc.conns synchronously before any
  // handler added afterwards runs. So by the time this fires, ydoc.conns
  // reflects the post-disconnect count, and size 0 means this really was
  // the room's last client.
  ws.on("close", () => {
    if (ydoc.conns.size === 0) {
      // Same invariant as the persist listener above: only flush a doc that
      // is known to reflect Postgres. Flushing an unhydrated doc here would
      // reintroduce the exact overwrite the `hydrated` gate exists to
      // prevent — and worse, on the close path there's no client left to
      // notice the room went blank.
      if (persistedRooms.has(roomId)) {
        flushPersist(roomId, ydoc);
      }
      stopRoomSync(roomId, ydoc);
      stopRoomAwarenessSync(roomId, ydoc);
    }
  });

  ws.resume();
}

module.exports = { handleYjsConnection };
