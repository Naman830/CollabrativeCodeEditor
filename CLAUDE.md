# Real-Time Collaborative Code Editor

A multiplayer code editor: Yjs CRDT sync over WebSockets, plus sandboxed multi-language
execution via a self-hosted Piston instance.

## Scope of work: follow `V1_Tasks.md`

`V1_Tasks.md` at the repo root is the **authoritative feature checklist for v1**. Read it
before starting any feature work — the user prompts against those items, so "build the user
bar" means the user-bar line in that file, not a fresh interpretation.

Rules:
- Work in the order given by its *Suggested build order* section unless the user names a
  specific item.
- Tick a box (`- [ ]` → `- [x]`) **only after** the feature is implemented and verified
  running, in the same change that implements it. Never tick ahead of the code.
- A parent bullet stays unticked until every one of its sub-bullets is ticked.
- Respect its *Explicitly out of scope for v1* list: **no database, no Redis, no auth, no
  server-side persistence.** Do not add them even as a convenience — see the
  "Not built yet" section below for what is deliberately deferred.
- If a task turns out to be wrong or impossible as written, say so and update the checklist
  text rather than silently ticking or skipping it.

## Repo layout

Two independent workspaces. **There is no root `package.json`** — install and run each separately.

| Path | What it is |
| --- | --- |
| `collab-code-editor/` | Next.js 16 (App Router) frontend. Monaco editor, room routing, and the `/api/execute` proxy to Piston. |
| `server/` | Standalone Node.js WebSocket server speaking the Yjs sync protocol, plus the room-lifetime HTTP routes on the same port. Deployed to Railway. |

Key files:
- `collab-code-editor/app/components/CodeEditor.tsx` — the whole client-side Yjs stack (doc, provider, awareness, Monaco binding)
- `collab-code-editor/app/room/[roomId]/page.tsx` — dynamic room route; `roomId` is the Yjs document name
- `collab-code-editor/app/components/RoomGate.tsx` — decides whether a room may be entered at all, *before* the editor (and therefore the socket) exists
- `collab-code-editor/app/lib/rooms.ts` — the client's view of room lifetime: `WS_URL`, the derived HTTP base, `createRoom()`, `checkRoom()`
- `collab-code-editor/app/lib/user.ts` — the entire user model: palette, name sanitizing, and identity as an external store
- `collab-code-editor/app/lib/awareness.ts` — `readPeers()`, the one boundary that turns hostile remote awareness state into values the UI may render
- `collab-code-editor/app/lib/languages.ts` — the one supported-language enumeration: dropdown labels, file extensions, and the Save filename; shared by the editor and the execute route
- `collab-code-editor/app/components/UserBar.tsx` — presence chips; renders only what `readPeers` returned
- `collab-code-editor/app/components/IdentityDialog.tsx` — the name/colour prompt, shared by the create and join flows
- `collab-code-editor/app/api/execute/route.ts` — server-side proxy to Piston
- `server/yjsConnection.js` — the only place that speaks the Yjs wire protocol; also the gate that refuses connections to rooms that don't exist
- `server/rooms.js` — the one authority on whether a room exists, and the only thing that ever deletes one

## Running locally

Three processes:

```bash
# 1. Piston sandbox (code execution)
cd collab-code-editor && docker compose up -d

# 2. Yjs WebSocket server -> :8080
cd server && npm install && cp .env.example .env && npm run dev

# 3. Frontend -> :3000
cd collab-code-editor && npm install && npm run dev
```

## Gotchas

**Docker context.** The running Piston container may live on the `default` docker context
while `desktop-linux` is *current*. `docker ps` then looks empty even though Piston is
serving `localhost:2000` fine. Check `docker context ls` and curl the API before concluding
Piston is down:

```bash
curl -s localhost:2000/api/v2/runtimes | head -c 200
```

**Piston version pinning.** `LANGUAGE_MAP` in `app/api/execute/route.ts` pins exact language
versions (e.g. `python@3.10.0`, `java@15.0.2`). They must match what `/api/v2/runtimes`
reports, or execution fails. Re-check that endpoint after any Piston image update.

**Piston's output cap is 1 KB by default, and it does not truncate.** When a stdio buffer
would exceed `output_max_size`, Piston drops the offending chunk and `SIGABRT`s the sandbox,
so the run comes back with `code: null`, `signal: "SIGKILL"`, `status: "OL"` and a stderr of
`Sandbox keeper received fatal signal 6` — which reads like a crash in the user's code but is
purely a limit. A 10x10 multiplication table (~1.1 KB) is enough to hit it. `docker-compose.yml`
now sets `PISTON_OUTPUT_MAX_SIZE: 65536`; **this lives only in compose, so a Piston started any
other way silently reverts to 1 KB.** The cap can still be hit, so `app/api/execute/route.ts`
also maps `run.status` (`OL`/`EL`/`TO`) to a plain-English `notice` field, strips the
fatal-signal line from stderr, and `CodeEditor.tsx` renders the notice in amber under the
output. `notice` is optional on `ExecuteSuccess` because older records may still sit in a
room's shared `execution` map.

**Seeding the document.** Starter code is inserted into the `Y.Text` only after the provider
fires `sync`. Seeding before sync would insert the boilerplate into a still-empty local doc,
and the CRDT would merge it into the existing document for everyone else in the room. Never
move the seed earlier, and never give Monaco a `defaultValue` — `MonacoBinding` resets the
model to the `Y.Text` contents when it attaches, so it would be discarded anyway.

**Yjs lifecycle is effect-scoped.** The `Y.Doc`, provider, awareness handler, and binding are
all created and destroyed inside one effect keyed on `roomId` *and the local user*. Do not
hoist the `Y.Doc` into component state — a cleanup that destroys a doc nothing recreates
breaks both room switching and React StrictMode's dev remount. The effect deliberately
early-returns until identity is known, so no socket opens before there is a name to announce.

**y-websocket's BroadcastChannel is disabled, and must stay disabled.** The provider is
constructed with `{ disableBc: true }`. By default y-websocket also syncs tabs of the same
origin peer-to-peer over a `BroadcastChannel`, which breaks presence: when a tab closes, the
server broadcasts the awareness removal, and a sibling tab immediately re-announces the
departed client with a higher clock. The peer is resurrected within milliseconds and never
ages out, because each re-announce refreshes its `lastUpdated` and so the 30s
`outdatedTimeout` never fires. Verified: with BC on, closing a tab left it in the user bar
indefinitely (still there after 10s); with BC off it disappears in under 2s. Departures
looked fine across two separate browser contexts, which is exactly the case BC does not
cover — so testing in one browser is what catches this, and it is also the documented way to
test multiplayer locally. Turning BC off costs nothing here: every real collaborator is a
different browser and syncs through the server regardless.

**Identity storage is split on purpose.** `app/lib/user.ts` keeps the active
`{firstName, lastName, color}` in **sessionStorage**, and mirrors only the *name* to
localStorage as a form prefill. sessionStorage is per-tab, so a second tab on the same room
is a genuinely separate collaborator — which is the only way to test multiplayer locally
without an incognito window. Consolidating both into localStorage looks like a
simplification and silently breaks that: both tabs become one user with one cursor. The
colour is excluded from the mirror for the same reason.

`setActiveUser()` is the single writer. It updates an in-memory snapshot as well as storage,
which matters because landing → room is a client-side navigation that keeps the module
alive; a stale snapshot would re-prompt someone who just filled the form in.

**Identity is read via `useSyncExternalStore`, not useState + useEffect.** `IdentityState` is
three-valued (`unknown` / `absent` / `present`) and the *server* snapshot is always
`unknown`, so the name prompt is never in the SSR output — otherwise it flashes at everyone
who already has a name. React 19's `react-hooks/set-state-in-effect` lint rule also rejects
the obvious `useEffect(() => setUser(load()))` version, so this is not merely a style
preference. `IdentityDialog` reads storage in lazy `useState` initializers, which is only
safe because callers keep it out of the server-rendered tree.

## Architecture invariant

Editing sync and code execution are deliberately **separate systems**. Editing is low-latency
and always-on; execution is bursty, resource-heavy, and handles untrusted input. Coupling
them would let a slow or crashed execution request degrade live editing for a whole room.

Within sync, there are likewise two protocols on the same socket:
- **Document updates** — durable CRDT ops, merged and replayed across reconnects
- **Awareness** — ephemeral cursor/selection/user state, dropped entirely on disconnect

Don't merge them: cursor positions must never enter document history.

**Awareness state is untrusted input.** Any peer sets its own `user` field to whatever it
likes — it never passes through our form, so sanitizing at the input boundary proves
nothing. `readPeers()` (`lib/awareness.ts`) is the single point that turns that raw state
into values the UI may render: names are re-sanitized (React escapes them, but an unbounded
or control-character name still wrecks the layout) and a colour failing `HEX_COLOR`
(`/^#[0-9a-f]{6}$/i`, exported from `lib/awareness.ts`) falls back to grey instead of
reaching an inline `style` or the cursor `<style>` tag. Without that check a peer can send
`red } body { display: none } .x {` and restyle every other participant's page; this was
verified exploitable before the guard was added.

The user bar and `CodeEditor.tsx`'s `renderAwarenessStyles` (the remote-cursor `<style>`
block) both consume `readPeers`'s output rather than touching `awareness.getStates()`
directly — neither may read raw awareness state itself. Anything new that renders a remote
name or colour (join/leave toasts) must go through `readPeers` too.

**`readPeers()` also deduplicates names and colors.** Two peers can independently end up
with the same short name (two "Naman Singla"s both display as `Naman S.`) or the same colour
(an 8-colour palette in `lib/user.ts`'s `CURSOR_COLORS`, picked at random per joiner with no
coordination). Neither is preventable in `IdentityDialog` — it has no `roomId` and no
awareness access, since the Yjs stack isn't created until identity is submitted (see the
effect-scoped lifecycle note above) — so there is no point before the dialog closes at which
"who else is here" is knowable. Both collisions are resolved reactively inside `readPeers`
once awareness makes them visible: a name shared by 2+ peers gets a 1-based number appended
(`Naman S.` → `Naman S1` / `Naman S2`), and a colour already claimed by an earlier peer is
swapped for the first unclaimed entry in `CURSOR_COLORS`. Resolution walks peers in ascending
`clientID` order, not the local-first order used for display — `clientID` is the one
ordering every connected client agrees on, so all viewers independently compute the same
winner for a contested name or colour. The user's originally-chosen colour in `sessionStorage`
is never touched; only the rendered copy shifts, and only while the collision lasts.

## Room lifetime

A room has three stages, and `server/rooms.js` is the only module that knows about any of
them:

```
reserved ──connect──► live ──last socket closes──► grace (10s) ──► destroyed
   │                    ▲                             │
   └─5 min, unclaimed───┘  reconnect cancels ─────────┘
```

`roomExists()` is true for all three stages, which is what makes a page refresh survive.

**y-websocket will not delete rooms for us, so this module must.** `closeConn` in
`y-websocket/bin/utils.js` puts `docs.delete(doc.name)` *inside* an
`if (doc.conns.size === 0 && persistence !== null)` branch, and this server deliberately
never calls `setPersistence`. Left alone, the `docs` map only ever grows: an "closed" room
still holds its old code, and memory is unbounded. `scheduleEviction()` owns that deletion
instead, and re-checks `conns.size === 0` *when the timer fires* rather than trusting the
cancel path — a reconnect landing inside the grace window must not lose its doc to a timer
that was already queued.

**Connecting to a room is what creates it, so the gate has to be server-side.**
`setupWSConnection` calls `map.setIfUndefined(docs, docName, …)`. A client-side check alone
would therefore be bypassed the instant the socket opened — the "dead" room would spring back
into existence, empty. `server/yjsConnection.js` refuses unknown rooms *before* calling
`setupWSConnection`, which is also what stops an old tab, reconnecting after an eviction or a
server restart, from silently resurrecting the room it remembers.

**Refusal is a post-handshake close with code 4404, not a rejected upgrade.** A rejected
upgrade reaches the browser as an opaque error with no code attached, and the client needs to
tell "this room is gone" (stop retrying, show the closed screen) from "the network blipped"
(keep retrying). The constant is `CLOSE_ROOM_NOT_FOUND`, duplicated in
`server/yjsConnection.js` and `CodeEditor.tsx` because the two workspaces share no code.
Note y-websocket keeps reconnecting forever on its own, so the client's handler must call
`provider.disconnect()` — that sets `shouldConnect = false`, which is the only thing `setupWS`
checks before re-dialling.

**Rooms are minted by the server (`POST /rooms`), not the browser.** This is the whole basis
of "this room ID doesn't exist": an ID nobody was ever issued is refused at connect time. The
landing page therefore fails *closed* when the sync server is unreachable, rather than
dropping someone into a room that can never sync. The POST deliberately sends **no body** —
adding a JSON `Content-Type` would make it a non-simple CORS request and buy a preflight
round trip before every room creation.

**`app/lib/rooms.ts` derives the HTTP base from `NEXT_PUBLIC_WS_URL`** by swapping the
scheme (`ws`→`http`). The sync server serves its room routes and the WebSocket upgrade off one
listener on one port, so there is intentionally no second env var that could drift.

**`missing` and `unreachable` are separate states and must stay separate.** `RoomGate`
redirects home only for `missing`; a sync server that can't be reached gets its own screen
with a Retry, because the room may be perfectly alive and unverifiable. Collapsing them would
tell people their room was gone every time the network hiccuped.

**`RoomGate` must not mount `CodeEditor` while checking.** Mounting the editor is what opens
the WebSocket, which is exactly what the gate exists to prevent — verified by asserting no
socket to the sync server is opened when a dead room ID is visited.

## Shared code execution (the Run button)

Clicking Run broadcasts the result to **everyone in the room**, not just the clicker. This
rides entirely on Yjs, not a new server message: `CodeEditor.tsx` puts a second shared type,
`yDoc.getMap<ExecutionState>("execution")`, on the *same* `Y.Doc` that already holds the code
(`yDoc.getText("monaco")`). y-websocket's sync protocol doesn't distinguish between shared
types — it merges the whole document — so this new map syncs to every peer, including late
joiners, for free. `server/yjsConnection.js` needed zero changes.

**One key, whole-record replacement.** The map has a single key, `"state"`, whose value is
the entire `ExecutionState` object — never separate sub-fields. That way a `.set("state", …)`
is atomic from Yjs's perspective: concurrent writes from two peers resolve to one complete
record, never a mix of fields from two different runs.

**`runId` resolves the one race the room-wide lock can't.** The Run button is disabled for
every peer whenever the shared status is `"running"` — but two peers can still click Run
before either has received the other's write over the WebSocket. Both writes converge on the
same winning record (Yjs's normal conflict resolution); the *loser's* Piston response, when it
eventually arrives, must recognise `executionMap.get("state")?.runId !== runId` and discard
itself rather than clobbering the winner. `handleRun`'s `stale()` check covers this, plus the
case where the effect torn down (room switch/unmount) while the fetch was in flight, via a
`collabRef` ref (a ref, not state — see the Yjs-lifecycle gotcha below: hoisting the doc into
state is exactly what must not happen, and a ref carries no such risk since it doesn't drive
renders).

**A dead runner can't be allowed to lock the room forever.** Verified while testing this
feature: if the peer who clicked Run closes their tab (or the network drops) before their
fetch to `/api/execute` resolves, the browser cancels that fetch outright — nothing ever
writes a final result, and since every peer's Run button stays disabled while status is
`"running"`, the room would otherwise be stuck showing "Running..." **permanently**, with no
way for anyone to ever click Run again. Fixed with a small watchdog: every connected client
runs a `setInterval` that checks whether the current `"running"` record is older than
`STALE_RUN_MS` (20s — set above the API route's own 15s Piston timeout plus round-trip
margin, so a merely-slow run is never pre-empted) and, if so, writes an `"error"` record
itself. There is no single "owner" of an abandoned run once it's shared state, so whichever
client's watchdog tick fires first heals it for everyone; the others' ticks are redundant,
idempotent no-ops.

**The Piston fetch has a 15s `AbortController` timeout** (`app/api/execute/route.ts`), added
for the same reason: a hang used to strand one user, but now strands the whole room's output
panel. This is a narrow fetch-level safety net, **not** V1_Tasks.md item 5 ("Reasonable
execution timeout") — that item is about sandbox-side execution/resource limits on the
program being run, a separate and larger piece of work.

**The output panel shows the run's own `language`, never the viewer's local dropdown
selection.** The language selector is a per-user editing preference — two peers can have
different languages selected locally while watching the same run — so the caption
("Run by Alice A. · Python") always reflects what actually executed, sourced from the shared
record, not from `language` state.

**Attribution bypasses `readPeers` on purpose.** `startedBy: {name, color}` is written from
the clicking user's own trusted `displayName(user)`/`user.color` (`lib/user.ts`) at the moment
they click Run — not from remote awareness. `readPeers`/`lib/awareness.ts` exists to sanitize
*other* peers' self-reported state; a client's own already-validated identity needs no such
gate, and going through `readPeers` here would be pointless indirection.

## Saving (the Save button)

Save is the mirror image of Run: **entirely local**, and deliberately so. It builds a `Blob`
from the editor's current text, clicks a throwaway `<a download>`, and revokes the object URL
— no Yjs write, no request to the server, nothing stored anywhere (V1_Tasks.md's core
principle: "saving a file means downloading it to the user's device").

It must stay off the shared `Y.Doc`. The language dropdown is a per-user editing preference,
so two peers looking at the same text can be on different languages, and each has to get
their own extension — verified with two tabs: one on C++ downloaded `main.cpp` while the
other downloaded `Main.java`, same contents. Putting the filename or a "last saved" flag into
shared state would force one peer's choice onto everyone.

**`app/lib/languages.ts` is the only place languages are enumerated.** It holds the dropdown
labels, the Monaco/Piston language ids, and the file extensions; `CodeEditor.tsx` and
`app/api/execute/route.ts` both import from it, and the route keeps only the pinned Piston
*versions* (a property of the sandbox image, not the language). The extension list used to
live solely in the route's `LANGUAGE_MAP`, which the client cannot import — it pulls in
`next/server` — so a Save button would have meant a second, silently-diverging copy.

**Java is the one capitalized filename.** `downloadFileName()` returns `Main.java`, not
`main.java`, because javac requires a public class to live in a file named after it; every
other language gets `main.<ext>`, matching the name the execute route hands Piston. Note the
route deliberately still sends `main.java` — Piston's payload filename is unrelated to the
local download, and changing it risks that runtime.

Save's only disabled state is an empty document. It has no equivalent of Run's room-wide
`"running"` lock, since there is nothing for two clickers to contend over.

## Environment variables

| Var | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_WS_URL` | `collab-code-editor/.env.local` | WebSocket server URL. Defaults to `ws://localhost:8080`; production points at the Railway `wss://` URL. **Also the source of the room-routes HTTP base** — `app/lib/rooms.ts` swaps the scheme, so there is no separate variable to keep in sync. |
| `PISTON_API_URL` | `collab-code-editor` | Piston base URL. Defaults to `http://localhost:2000`. |
| `PORT` | `server/.env` | Port for both the WebSocket upgrade and the room HTTP routes. Defaults to `8080`. |
| `ROOM_GRACE_MS` | `server/.env` | How long an emptied room lingers before destruction. Defaults to `10000`. |
| `ROOM_RESERVATION_MS` | `server/.env` | How long a created-but-never-entered room stays claimable. Defaults to `300000`. |

## Not built yet

Postgres persistence, Redis pub/sub for horizontal scaling, and execution resource limits are
all on the roadmap but unimplemented. **Documents are in-memory only — room state does not
survive a WebSocket server restart**, and since a restart wipes the room registry too, every
client still in a room gets its reconnect refused and is sent home (see "Room lifetime").
Piston is local-only; code execution does not work on the deployed site.

Room eviction *is* implemented — see "Room lifetime" above; that section replaces an older
note here claiming rooms are never evicted.

**The reservation ceiling is not rate limiting.** `MAX_RESERVATIONS` in `server/rooms.js`
stops `POST /rooms` from growing the map without bound, but it is a global cap with no notion
of *who* is calling — V1_Tasks.md §7's "basic rate limiting on room creation" is still open.

@collab-code-editor/AGENTS.md
