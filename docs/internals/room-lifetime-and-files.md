# Room lifetime and multi-file rooms

How a room is created, how long it lives, who may connect to it, and the shared shape of the files inside it.

*Split out of `CLAUDE.md` on 2026-07-31. Same rules apply: this is the **why** — measurements,
rejected alternatives, debugging history. The code carries the rule, this carries the rationale,
and a change that contradicts a paragraph here rewrites it rather than appending a correction.*

## Room lifetime

A room has three stages, and `server/src/rooms/lifecycle.js` is the only module that knows about any of
them:

```
reserved ──connect──► live ──last socket closes──► grace (10s) ──► destroyed
   │                    ▲                             │
   └─5 min, unclaimed───┘  reconnect cancels ─────────┘
```

`roomExists()` is true for all three stages, which is what makes a page refresh survive.

Since 7.5 there is a fifth state that the diagram cannot show, because it belongs to no room:
**destroyed-but-unwritten.** A snapshot handed to `server/src/storage/snapshotQueue.js` outlives the room
object it came from — `docs` and `reservations` no longer know the ID, `roomExists()` answers
false, and the `Y.Doc` is gone, but the row has not landed yet. Nothing about rejoining changes
(the ID stays refused, which is 7.5's first bullet), but two things follow: the queue holds the
only copy of that work, so its bounds are data-loss decisions rather than tuning; and a shutdown
must drain it explicitly, since no live room is left to keep the process alive on its behalf.

**y-websocket will not delete rooms for us, so this module must.** `closeConn` in
`y-websocket/bin/utils.js` puts `docs.delete(doc.name)` *inside* an
`if (doc.conns.size === 0 && persistence !== null)` branch, and this server deliberately
never calls `setPersistence`. Left alone, the `docs` map only ever grows: an "closed" room
still holds its old code, and memory is unbounded. `scheduleEviction()` owns that deletion
instead, and re-checks `conns.size === 0` *when the timer fires* rather than trusting the
cancel path — a reconnect landing inside the grace window must not lose its doc to a timer
that was already queued.

**`destroyRoom()` is the single destroy site, and therefore the only place a snapshot can be
taken** (see "Dead-room snapshots" for what it writes and the ordering constraints that make it
safe). Both the grace-expiry timer and the shutdown flush funnel through it. A fourth stage is
now implicit in the diagram above: **shutdown**, which destroys every room in `docs` regardless
of stage, because the process is about to take the registry with it.

**An `Awareness` holds a 3s `setInterval` that is *not* `unref()`'d** (`awareness.cjs`,
`floor(outdatedTimeout / 10)`). That is why the sync server never exits on its own, and why
destroying every doc during shutdown is also what lets Node drain and exit naturally — which is
preferable to `process.exit`, since that truncates pending stdout writes on Railway.

**Connecting to a room is what creates it, so the gate has to be server-side.**
`setupWSConnection` calls `map.setIfUndefined(docs, docName, …)`. A client-side check alone
would therefore be bypassed the instant the socket opened — the "dead" room would spring back
into existence, empty. `server/src/sync/connection.js` refuses unknown rooms *before* calling
`setupWSConnection`, which is also what stops an old tab, reconnecting after an eviction or a
server restart, from silently resurrecting the room it remembers.

**Refusal is a post-handshake close with code 4404, not a rejected upgrade.** A rejected
upgrade reaches the browser as an opaque error with no code attached, and the client needs to
tell "this room is gone" (stop retrying, show the closed screen) from "the network blipped"
(keep retrying). The constant is `CLOSE_ROOM_NOT_FOUND`, duplicated in
`server/src/sync/connection.js` and `web/src/hooks/useCollabRoom.ts` because the two workspaces share no code.
Note y-websocket keeps reconnecting forever on its own, so the client's handler must call
`provider.disconnect()` — that sets `shouldConnect = false`, which is the only thing `setupWS`
checks before re-dialling.

**`GET /rooms/:roomId` always answers HTTP 200 — existence is the `exists` field
in the body.** There is no 404 for a dead room, which is what `web/src/lib/collab/rooms.ts`'s `checkRoom`
relies on: a non-`ok` response means *unreachable*, and only `{"exists": false}` means
*missing*. Anything asserting on the status code (a health check, a test) will read every
dead room as alive.

**Rooms are minted by the server (`POST /rooms`), not the browser.** This is the whole basis
of "this room ID doesn't exist": an ID nobody was ever issued is refused at connect time. The
landing page therefore fails *closed* when the sync server is unreachable, rather than
dropping someone into a room that can never sync. The POST deliberately sends **no body** —
adding a JSON `Content-Type` would make it a non-simple CORS request and buy a preflight
round trip before every room creation.

**`web/src/lib/collab/rooms.ts` derives the HTTP base from `NEXT_PUBLIC_WS_URL`** by swapping the
scheme (`ws`→`http`). The sync server serves its room routes and the WebSocket upgrade off one
listener on one port, so there is intentionally no second env var that could drift.

**`missing` and `unreachable` are separate states and must stay separate.** `RoomGate`
redirects home only for `missing`; a sync server that can't be reached gets its own screen
with a Retry, because the room may be perfectly alive and unverifiable. Collapsing them would
tell people their room was gone every time the network hiccuped.

**`RoomGate` must not mount `CodeEditor` while checking.** Mounting the editor is what opens
the WebSocket, which is exactly what the gate exists to prevent — verified by asserting no
socket to the sync server is opened when a dead room ID is visited.

## Multi-file rooms (task 10.1)

A room holds up to 20 files. The language is chosen **once, at room creation**, every file gets
that language's extension, one file is starred as the **entry file** — the one Run executes —
and Save produces `project.zip` when there is more than one. `web/src/lib/collab/roomFiles.ts` is the only
description of the shape:

```
yDoc
 ├─ Y.Map  "files"     fileId -> { name, createdAt }
 ├─ Y.Map  "roomMeta"  "entry" -> fileId
 ├─ Y.Text "file:<id>" one per file
 └─ Y.Map  "execution" unchanged
```

**The spec for multi-file rooms said "each file = its own Yjs sub-document". That is not what
shipped, and it could not be.** `setupWSConnection` in `y-websocket/bin/utils.js` syncs exactly one doc per
socket and never handles `doc.on('subdocs')`, so real subdocs would need a provider and a
separately-gated WebSocket per open file, N token-refresh paths, and child-doc handling in
`server/src/rooms/lifecycle.js` and `server/src/rooms/state.js`. A `Y.Text` per file on the *same* doc is the trick
the `execution` map already uses — y-websocket merges the whole document, so files reach every
peer including late joiners with zero server protocol change. The checklist bullet was rewritten
rather than silently ticked.

**The first file's id is the literal string `"main"`, and it must stay fixed.** Two peers can
sync into an empty room at the same instant and both run the seed. With random ids they create
two identical `main.py` tabs which CRDT-merge into two entries; with a fixed key they write the
same map entry and the same `Y.Text`, so they converge on one file and the seed's text insert
degrades to the benign duplicate-insert v1 already had. Every *other* file gets a random id.

**Tab order is derived, never stored** — `createdAt`, tiebroken by id. A shared ordering array
would need its own conflict story (two peers reordering; an entry for a file someone else
deleted). `server/src/rooms/state.js` derives the identical order when it writes the snapshot, so the
zip, the tab strip and `/profile` all agree without anything on the wire carrying an order.

**A file's metadata is replaced whole per key**, exactly as `EXECUTION_KEY` is. A rename writes
`files.set(id, {...meta, name})`. Never a nested `Y.Map` per file: two peers touching different
fields would interleave into a record neither wrote.

**`readRoomFiles()` is a sanitizing boundary, in the same category as `readPeers()`.** Filenames
are peer-supplied — a raw Yjs client writes whatever it likes into that map — and the name then
reaches a tab label, an `<a download>`, a **zip entry key**, and ultimately `dead_rooms.files`.
Path separators matter most, since those three interpret a name rather than merely displaying
it. `server/src/rooms/state.js` repeats the whole check on its own side, because the client code never
runs for a hostile peer; verified end to end by putting `../../etc/pa sswd<lone surrogate>.py`
into a real room and finding `....etcpa sswd.py` in Postgres. Nothing may read the raw map.

(An earlier version of that sentence wrote the result as `....etcpasswd.py`. Off by one character:
the internal space is **collapsed** by the `\s+` pass, not removed. `VAL-04e` pins the real value.
The part that matters is unchanged — the separators and the lone surrogate are both gone.)

### Monaco: one model and one binding per file, one editor forever

**Switching files is the `path` prop on `EditorPane`, and nothing else.** Verified against
`@monaco-editor/react@4.7`'s source: when `path` changes it resolves
`editor.getModel(Uri.parse(path))`, creates the model if new, saves the outgoing view state and
calls `editor.setModel(...)`. The editor instance is untouched and `onMount` does not re-fire —
so the whole Yjs stack survives a tab switch. A `key`, or one `<EditorPane>` per file behind a
ternary, would each do exactly what that file's three existing rules forbid.

Model URIs are `inmemory://room/<roomId>/<fileId>` — the **id**, not the name, or every rename
would orphan a model and its binding. The room id is in there because Monaco's model registry is
global to the page, not to a component.

**Bindings are long-lived: one per file, never rebuilt on a tab switch.** Two reasons, both
verified against `y-monaco@0.1.6`:

- It is unnecessary. `_rerenderDecorations`, `_beforeTransaction` and the cursor-selection
  listener all guard on `editor.getModel() === monacoModel`, and decorations additionally check
  `anchorAbs.type === ytext`. Every binding but the visible one is already a no-op.
- It would leak. **`MonacoBinding.destroy()` does not dispose the `onDidChangeCursorSelection`
  listener it registers on the editor** — only the content and dispose handlers. Churning
  bindings per switch strands one listener per switch for the room's life.

The reconciliation effect in `useCollabRoom` is **declared before the master effect**, because
React runs effect cleanups in declaration order: this one must tear its bindings down while the
`Y.Doc` is still alive. It is driven by the Yjs observer rather than by React state, so a file
appearing never re-runs the effect (which would dispose every model). Inside `sync()`, **models
are created before removed ones are disposed**, and the editor is moved off a model that is about
to die — otherwise deleting the open file leaves the editor holding a disposed model until React
catches up, which paints an unusable pane.

**`didEdit` now tests `origin instanceof MonacoBinding`, not identity against one binding**,
since typing in any file is typing. The four file actions (create/rename/delete/set-entry) latch
it explicitly: they are local transactions with a null origin, exactly like the seed — which must
*not* count — so the difference is intent, and only the call site knows it.

### The language is server-authoritative

`POST /rooms?language=python` — a **query parameter, not a body**, because a body means a
`Content-Type` and a non-simple CORS request, i.e. a preflight round trip before every room
creation (see "Rooms are minted by the server"). `GET /rooms/:roomId` hands it back, which is how
someone who was *sent a link* opens the room in the language it was made in rather than a guess,
and it is the reason the language is not seeded into the `Y.Doc`: a peer arriving before the
creator has synced would otherwise see nothing.

`ROOM_LANGUAGES` in `server/src/rooms/state.js` is the **sixth** hand-maintained cross-workspace
duplication, after `rateLimit.js`/`rateLimit.ts`, `CLOSE_ROOM_NOT_FOUND`, `rooms/state.js`'s
`sanitizeName`/`HEX_COLOR`, `TRUNCATION_MARKER` and `MEMBER_MIN_CONNECTED_MS`. It is an allowlist
rather than "store whatever arrived" because that endpoint is anonymous and the value is written
to `dead_rooms.language` and rendered on `/profile`; an unknown value falls back to `javascript`
rather than 400ing, so a stale client never loses the ability to create a room.

In the room the language is a **read-only chip** in `RoomChrome`. Changing it mid-room would make
every existing file's extension a lie.

