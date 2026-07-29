# Real-Time Collaborative Code Editor

A multiplayer code editor: Yjs CRDT sync over WebSockets, plus sandboxed multi-language
execution via a self-hosted Piston instance.

## Scope of work: follow `tasks.md`

`tasks.md` at the repo root is the **authoritative feature checklist for v2**, and the only
checklist left in the repo — v1 shipped complete and `V1_Tasks.md` was deleted once every box
was ticked (commit `dfbaf1b`). Read `tasks.md` before starting any feature work: the user
prompts against its items, so "build the profile page" means the `/profile` lines in section
7.4, not a fresh interpretation.

Rules:
- Work in the order given by its *Suggested build order for v2* section (section 9) unless
  the user names a specific item. The extras in section 10 (multi-file, chat, room password)
  come after the six numbered steps unless the user says otherwise.
- Tick a box (`- [ ]` → `- [x]`) **only after** the feature is implemented and verified
  running, in the same change that implements it. Never tick ahead of the code.
- A parent bullet stays unticked until every one of its sub-bullets is ticked.
- Respect its *Explicitly out of scope for v2* list (section 8): **Postgres is the only data
  store — no Redis, no cache, no session store**; a dead room is never re-run, re-joined, or
  edited in place; no horizontal scaling. Do not add them even as a convenience.
- If a task turns out to be wrong or impossible as written, say so and update the checklist
  text rather than silently ticking or skipping it.

### Every completed task updates the docs in the same change

Before reporting any task done, do all three of these — not in a follow-up commit:

1. **Tick the box in `tasks.md`.** Same change as the code, never before it.
2. **Update this file (`CLAUDE.md`).** Add or revise whatever section the change makes true:
   a new key file in the *Repo layout* table, a new env var in the *Environment variables*
   table, a new invariant, and — importantly — anything that bit you while building it. This
   file's value is the gotchas, not the feature list; if a limit, ordering, or lifecycle
   detail was non-obvious enough to cost you a debugging session, write it down.
3. **Write down features that were not in `tasks.md`.** If you build something the checklist
   never listed — an extra guardrail, a helper endpoint, a UI affordance the user asked for
   mid-task — add it to `tasks.md` as a new, already-ticked line under the nearest matching
   section (or a new subsection if none fits), so the checklist keeps describing what actually
   shipped. A checklist that omits shipped work is worse than no checklist.

The same rule applies to anything that turns out to be *false*: when a change contradicts a
paragraph in this file, rewrite that paragraph rather than appending a correction next to it.

## What v2 adds (`tasks.md` in one paragraph)

v1's defining constraint was **zero persistence** — a room and everything in it vanished when
the last person left. v2 keeps that for the live room and relaxes it in exactly one place:
**Clerk** adds real accounts alongside the unchanged guest flow, and when a room dies its final
files are written **once** to a `dead_rooms` table in **PostgreSQL** — but only if at least one
participant was signed in. Fully-guest rooms still save nothing at all. The snapshot is
read-only forever: a `/profile` page lists a signed-in user's past rooms and lets them view and
copy the code, never run or rejoin it. Sync, awareness, room lifetime, and Piston execution are
all **unchanged** from v1. Three extras ride along (section 10): multi-file rooms with the
language chosen once at creation and a starred entry file, an ephemeral in-room chat over the
existing WebSocket, and optional room passwords held only in the in-memory room object.

## Repo layout

Two independent workspaces. **There is no root `package.json`** — install and run each separately.

| Path | What it is |
| --- | --- |
| `collab-code-editor/` | Next.js 16 (App Router) frontend. Monaco editor, room routing, and the `/api/execute` proxy to Piston. |
| `server/` | Standalone Node.js WebSocket server speaking the Yjs sync protocol, plus the room-lifetime HTTP routes on the same port. Deployed to Railway. |

Key files:
- `collab-code-editor/proxy.ts` — Clerk's request hook. **Next 16 renamed `middleware.ts` to `proxy.ts`**; it attaches the session and protects nothing
- `collab-code-editor/app/lib/clerkIdentity.ts` — the one boundary between Clerk and the app; nothing else imports `useUser`
- `collab-code-editor/app/lib/monacoLoader.ts` — points `@monaco-editor/react` at the npm package so no global AMD loader is installed
- `collab-code-editor/app/components/CodeEditor.tsx` — the whole client-side Yjs stack (doc, provider, awareness, Monaco binding)
- `collab-code-editor/app/room/[roomId]/page.tsx` — dynamic room route; `roomId` is the Yjs document name
- `collab-code-editor/app/components/RoomGate.tsx` — decides whether a room may be entered at all, *before* the editor (and therefore the socket) exists
- `collab-code-editor/app/lib/rooms.ts` — the client's view of room lifetime: `WS_URL`, the derived HTTP base, `createRoom()`, `checkRoom()`
- `collab-code-editor/app/lib/user.ts` — the entire user model: palette, name sanitizing, and identity as an external store
- `collab-code-editor/app/lib/awareness.ts` — `readPeers()`, the one boundary that turns hostile remote awareness state into values the UI may render
- `collab-code-editor/app/lib/languages.ts` — the one supported-language enumeration: dropdown labels, file extensions, and the Save filename; shared by the editor and the execute route
- `collab-code-editor/app/components/UserBar.tsx` — presence chips; renders only what `readPeers` returned
- `collab-code-editor/app/components/IdentityDialog.tsx` — the name/colour prompt, shared by the create and join flows
- `collab-code-editor/app/lib/execution.ts` — the cap on what may be *sent* for execution (`MAX_CODE_BYTES`), shared by the client's pre-flight check and the route's 413
- `collab-code-editor/app/lib/rateLimit.ts` / `server/rateLimit.js` — the same in-memory sliding-window limiter, once per workspace
- `collab-code-editor/app/api/execute/route.ts` — server-side proxy to Piston; also where the sandbox-side execution limits live
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

**Piston validates every per-request limit against a configured ceiling, and 400s the whole
request if one exceeds it** (`run_timeout cannot exceed the configured limit of 3000`). So
the numbers in `app/api/execute/route.ts` and the `PISTON_*` vars in `docker-compose.yml` are
one setting in two places: **never raise the route's without raising compose's first.**
Like `PISTON_OUTPUT_MAX_SIZE`, those vars live only in compose, so a Piston started any
other way reverts to defaults — and the defaults are the *tighter* ones (3s run), which
means every run fails outright rather than silently loosening. See "Execution limits" below.

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

**`tasks.md`'s section-5 sequence diagram draws execution wrong — do not implement it as
drawn.** It shows `FE → WS → Piston`, i.e. the code travelling to the WebSocket server, which
then calls Piston and broadcasts the result. That is not how v1 works and must not become how
v2 works: the browser posts to the Next.js route `/api/execute`, which proxies to Piston, and
the *result* is shared through the Yjs `execution` map (see "Shared code execution" below).
The diagram's intent — everyone in the room sees the run — is already satisfied. Routing runs
through the sync server would put an untrusted, resource-heavy, 18-second-timeout request on
the same process and event loop as live editing, which the next paragraph exists to prevent.

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

## Accounts (Clerk)

Signing in is **optional and additive**: every guest path from v1 works untouched, and the
only thing an account currently buys is that the identity record carries a `clerkUserId`
(`tasks.md` 7.1). Nothing is persisted yet — that is 7.2/7.3.

**It is `proxy.ts`, not `middleware.ts`.** Next 16 renamed the convention
(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`: *"the
`middleware` file convention is deprecated and has been renamed to `proxy`"*). The contents
are identical, so every Clerk recipe written for Next ≤15 is right about the code and wrong
about the filename — and a `middleware.ts` here is simply never loaded, silently. Confirm it
is wired by looking for `ƒ Proxy (Middleware)` in `next build` output, or the `proxy.ts: Nms`
segment in a dev request log.

**`clerkMiddleware()` is called with no callback, and must stay that way.** It attaches the
session and protects nothing. `/`, `/room/*` and `/api/execute` are all public by design —
`/api/execute` especially, since adding `auth.protect()` there would break the Run button for
every guest. Route protection belongs in the resource (`await auth()` in the page), which is
also what replaced the now-deprecated `createRouteMatcher`.

**`clerkUserId` is client-only and must never enter awareness.** It rides inside `CollabUser`
to sessionStorage via `setActiveUser`, and stops there. The awareness payload in
`CodeEditor.tsx` lists its fields one by one and must never become `{...user}`: awareness is
peer-controlled, so a broadcast account ID is a claim anyone can forge, and 7.3 keys saved
room snapshots on an account. Sourcing that from awareness would let a passing guest write a
room's code into a stranger's profile — the same class of hole as the CSS-colour injection
`readPeers` guards, but the blast radius is another user's stored data. **7.3 must get the
signed-in user from a verified Clerk token instead**, either via `await auth()` in a Next
route handler that tells `server/` server-to-server, or `verifyToken` from `@clerk/backend`
on the socket. Note `server/yjsConnection.js` already discards the query string
(`req.url.slice(1).split("?")[0]`), so a `?token=` can be added without changing the doc name.

**Signing in prefills the identity dialog; it does not replace it.** The Clerk session is a
cookie (browser-wide) while `CollabUser` is sessionStorage (per-tab) — different scopes on
purpose. Deriving the collaborator from Clerk and skipping the prompt looks like the obvious
win and breaks two things: Clerk's `lastName` is nullable while `isValidUser` requires both
names, and two tabs would become one collaborator, which is exactly the local-multiplayer
test story the storage split exists to protect. Verified: two tabs signed into one account
still show as two people with two colours.

**The dialog must never wait on Clerk.** `useUser()` reports `isLoaded: false` first, and the
dialog reads its prefill in lazy `useState` initializers that run once — so the tempting fix
is to hold the dialog until Clerk resolves. Don't: verified by deep-linking into a room from
a fresh browser profile, where the prompt never rendered and **the room could not be joined
at all**. Instead the dialog renders immediately and a `key` remounts it once if a signed-in
session arrives late. A guest's key never changes, so the common path never remounts and
nothing typed is lost. `signedInUser()` in `lib/clerkIdentity.ts` collapses "guest" and "not
loaded yet" into one `null` precisely so no caller can reintroduce that gate.

**Monaco's AMD loader broke Clerk, and this is why `app/lib/monacoLoader.ts` exists.**
`@monaco-editor/react` defaults to fetching Monaco from a CDN with an AMD loader, which
installs a global `define` carrying `define.amd`. Any UMD bundle loaded afterwards then
registers itself as an AMD module instead of executing — and Clerk's UI bundle is one, so it
failed with `failed_to_load_clerk_ui` and Clerk never finished loading **on the room route
only**. The symptom was a signed-in user deep-linking into a room silently having no session
and no `clerkUserId`. It is a race between two CDN fetches, so it reproduced intermittently;
the controlled experiment that pinned it was visiting a *dead* room ID, where `RoomGate` shows
the closed screen and never mounts Monaco — there Clerk resolved fine on the very same route.
The fix points the loader at the `monaco-editor` package (now a direct dependency), so no AMD
loader is ever installed and Monaco stops being a runtime CDN dependency too. `loader.config`
runs at module scope in `CodeEditor.tsx`, because it must happen before the first `<Editor>`
mounts.

**Clerk components are themed with `appearance.variables`, deliberately not `@clerk/ui`.**
The `dark` theme lives in a separate `@clerk/ui` package whose bundle Clerk fetches at
runtime — the very bundle the AMD conflict above breaks. The variables ship inside clerk-js
itself, need no second bundle, and reproduce the palette from `globals.css`. (Also worth
knowing: `Show` exported from `@clerk/nextjs` is an **async server component**, so it cannot
be used in the `"use client"` landing page — branch on `useClerkIdentity()` instead. And
`SignedIn`/`SignedOut` no longer exist in v7 at all.)

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
`STALE_RUN_MS` and, if so, writes an `"error"` record itself. There is no single "owner" of an
abandoned run once it's shared state, so whichever client's watchdog tick fires first heals it
for everyone; the others' ticks are redundant, idempotent no-ops.

**Three timeouts are nested, and the ordering is the whole point.** Innermost, the sandbox
stops the *program* (10s compile + 5s run at worst). Then the route's `PISTON_TIMEOUT_MS`
(18s `AbortController`) catches a Piston that never answers at all. Outermost,
`STALE_RUN_MS` (25s) decides the *client* is gone. Each layer must sit above the one it
contains or it starts firing on cases the inner layer was about to handle correctly — set
the fetch abort to 15s and a legitimate 10s-compile-plus-5s-run reports "Execution timed
out"; set the watchdog below the fetch abort and a merely-slow run is reported room-wide as
a lost connection. Change one and re-check all three.

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

## Execution limits (what a run may consume)

Sent with every Piston request from `app/api/execute/route.ts`, and mirrored as ceilings in
`docker-compose.yml` (see the Piston gotcha above — Piston 400s a request that exceeds its
configured limit, so the two files are one setting in two places):

| Limit | Value | Why |
| --- | --- | --- |
| `run_timeout` / `run_cpu_time` | 5s each | Wall and CPU are **separate** ceilings in Piston, and both must be raised together. `while True: pass` burns CPU as fast as wall clock, so raising only `run_timeout` leaves it dying at the 3s default `run_cpu_time` — verified: it was killed at 3.1s with `run_timeout: 5000` set. |
| `compile_timeout` / `compile_cpu_time` | 10s each | Piston's own defaults; javac and g++ need the room. |
| `run_memory_limit` | 256 MB | An allocation loop is stopped here rather than by the host running out of memory. |
| `compile_memory_limit` | 512 MB | Verified sufficient for the java and c++ packages; the run stage is the one worth squeezing. |

Piston's untouched defaults do the rest of the work and are worth knowing before adding
another limit: `max_process_count` (64) is what bounds a fork bomb and `max_open_files`
(2048) a descriptor loop.

**A sandbox-killed program must not read as a crash in the user's code.** Piston reports an
out-of-memory kill as exit code 137 with a line from its own shell wrapper
(`/piston/packages/python/3.10.0/run: line 3: 3 Killed …`), which exposes sandbox internals
and says nothing about memory. `noticeFor()` turns it into a plain sentence and
`OOM_KILL_NOISE` strips the line, exactly as `SANDBOX_KEEPER_NOISE` does for the output cap.

**Status `"RE"` means *any* non-zero exit, so it is not by itself notice-worthy.** A normal
`raise ValueError` comes back as `status: "RE", code: 1` — stderr and the exit code already
say that, and an amber "Exited with error status 1" over the top is pure noise. Only
`code === 137` (128 + SIGKILL) earns a notice.

## Rate limiting and payload size

Both endpoints that cost real resources are limited to **10 requests/minute/IP**:
`POST /rooms` on the sync server and `POST /api/execute` on the frontend. The limiter is an
in-memory sliding window, duplicated once per workspace (`server/rateLimit.js`,
`app/lib/rateLimit.ts`) — the two workspaces share no code, the same reason
`CLOSE_ROOM_NOT_FOUND` exists twice.

**The frontend limiter is honestly approximate and the code says so.** No Redis and no
database is a v1 constraint, not an oversight, so there is no shared counter: on Vercel each
serverless instance keeps its own, and a caller spread across N warm instances gets up to N
times the nominal limit. It converts an unbounded flood into a bounded one; it is not a
security boundary. The sync-server side *is* exact — one Railway process, one counter.

**This is a different thing from `MAX_RESERVATIONS`.** That is a global ceiling on unclaimed
rooms with no notion of who created them; this bounds a single caller. Both are needed: the
limiter stops one script exhausting the ceiling, the ceiling stops many callers doing it.

**A 429 must not be reported as "couldn't reach the sync server".** Rate limiting makes "the
server answered and refused" a state a normal user can hit, and the two call for opposite
reactions (wait vs retry now). `createRoom()` therefore throws a `RoomCreateError` carrying
the server's own wording, and only an unanswered request falls back to the reachability
message.

**`MAX_CODE_BYTES` (64 KB) is checked twice, deliberately.** `Content-Length` is checked
before the body is read, so an absurd payload is refused without being buffered — but that
header measures the JSON envelope, and escaping can nearly double a program made of quotes
and newlines, so the cheap check is deliberately *loose* (`MAX_CODE_BYTES * 2 + 4 KB`). The
exact check runs on the decoded `code` string afterwards and is the one that enforces the
cap. Both use UTF-8 byte length, not `String.length`: a document of emoji or CJK is up to 4x
its character count on the wire, and the wire size is what is being capped.

`CodeEditor.tsx` checks the same constant from `app/lib/execution.ts` before fetching. That
is a courtesy, not the enforcement — the route is reachable without the UI — but it means an
oversized document never crosses the wire, and it writes the failure into the shared
`execution` map like any other result, since the document is shared and so is the problem.

## Saving (the Save button)

Save is the mirror image of Run: **entirely local**, and deliberately so. It builds a `Blob`
from the editor's current text, clicks a throwaway `<a download>`, and revokes the object URL
— no Yjs write, no request to the server, nothing stored anywhere (v1's core principle:
"saving a file means downloading it to the user's device"). v2 keeps Save local; the only
thing that ever reaches Postgres is the automatic dead-room snapshot, never a Save click. Note
section 10.1 of `tasks.md` changes *what* Save produces once multi-file lands — one file
downloads directly as today, 2+ files zip into `project.zip` via JSZip — but not where it
goes.

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
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `collab-code-editor/.env.local` | Clerk API keys. **What breaks without them is not what you would guess**: `next build` still succeeds (`proxy.ts` doesn't run at build time) and `next dev` still boots, because `@clerk/nextjs` falls back to *keyless mode* and provisions a throwaway instance under `.clerk/` — but `clerkMiddleware()` asserts both keys on **every matched request** and keyless is development-only, so a production start 500s the whole site. `.clerk/` holds that throwaway instance's secret key and is gitignored. |
| `PISTON_API_URL` | `collab-code-editor` | Piston base URL. Defaults to `http://localhost:2000`. **No trailing slash** — `app/api/execute/route.ts` appends `/api/v2/execute`. On Vercel it holds the tunnel hostname (see "Production execution path"); Vercel env changes only reach a *new* deployment, so changing it requires a redeploy. |
| `PISTON_OUTPUT_MAX_SIZE`, `PISTON_RUN_TIMEOUT`, `PISTON_RUN_CPU_TIME`, `PISTON_COMPILE_TIMEOUT`, `PISTON_COMPILE_CPU_TIME`, `PISTON_RUN_MEMORY_LIMIT`, `PISTON_COMPILE_MEMORY_LIMIT` | `collab-code-editor/docker-compose.yml` | Ceilings inside the Piston container, **not** app config — they exist only in compose, and Piston rejects any per-request limit above them. Keep in step with the constants in `app/api/execute/route.ts`. |
| `PORT` | `server/.env` | Port for both the WebSocket upgrade and the room HTTP routes. Defaults to `8080`. |
| `ROOM_GRACE_MS` | `server/.env` | How long an emptied room lingers before destruction. Defaults to `10000`. |
| `ROOM_RESERVATION_MS` | `server/.env` | How long a created-but-never-entered room stays claimable. Defaults to `300000`. |

## Production execution path

Piston cannot be deployed alongside the other two services: it needs a **privileged**
container (`isolate`, cgroups, `tmpfs … :exec`), which neither Vercel nor Railway allows.
The public Piston API at `emkc.org` is not a fallback — it went **whitelist-only on
2026-02-15** and now `401`s every request.

So the deployed `/api/execute` talks to a Piston running on a developer machine, reached
through a **reserved ngrok hostname** held in `PISTON_API_URL`. Two facts follow, and both
have already caused confusion once:

- **Run only works while that machine is online.** This is a property of the deployment, not
  a bug. Piston down → `"Could not reach the code execution service."`
- **Tunnel down reads as a *different* error.** ngrok/Cloudflare answer with an HTML error
  page, which fails `pistonRes.json()` and surfaces as `"Code execution service returned an
  invalid response."` (`route.ts`'s second 502). That string means *the tunnel*, never Piston
  and never the user's code.

The hostname must be **reserved**, not a quick tunnel. A `trycloudflare`/anonymous tunnel
mints a new URL on every restart, and since a Vercel env change only reaches a *new*
deployment, each restart would cost an env edit **plus a redeploy**. The reserved hostname is
set once and then survives reboots.

On the current machine that tunnel is a `systemd --user` unit, `ngrok-piston.service`
(`Restart=always`, so it recovers from network changes), and Piston itself is
`restart: unless-stopped` in `docker-compose.yml`, so both return after a reboot.

The five versions pinned in `LANGUAGE_MAP` match a stock `ghcr.io/engineer-man/piston`
image, so pointing `PISTON_API_URL` at any self-hosted instance needs no code change. The
image is **amd64-only** (single-arch manifest) — ARM free tiers cannot host it.

## Not built yet

**Section 7.1 (Clerk auth) is done — see "Accounts (Clerk)" above, which replaces an older
note here claiming no Clerk existed. Everything else in `tasks.md` (v2) is still unticked:**
no Postgres, no `dead_rooms` table, no `/profile`, no multi-file, no chat, no room passwords.
Redis pub/sub for horizontal scaling is *not* a v2 item at all — section 8 puts it explicitly
out of scope, so it stays deferred past v2.

Because 7.2 (Postgres) is not built, **an account currently changes nothing that outlives the
tab**: `clerkUserId` reaches sessionStorage and no further. Do not add UI promising a signed-in
user that a room will be saved to their profile until 7.3 actually writes the snapshot.

**Documents are in-memory only — room state does not survive a WebSocket server restart**, and
since a restart wipes the room registry too, every client still in a room gets its reconnect
refused and is sent home (see "Room lifetime"). v2's dead-room snapshots do not change this:
they are written when a room dies normally, and a crashed server still loses whatever was
open.

Hosting Piston
somewhere always-on (a VPS permitting privileged containers) is the one roadmap item that
would make execution independent of a developer machine — see "Production execution path"
above, which replaces an older note here claiming execution simply does not work in
production.

Room eviction *is* implemented — see "Room lifetime" above; that section replaces an older
note here claiming rooms are never evicted. Execution resource limits and rate limiting are
likewise implemented now — see "Execution limits" and "Rate limiting and payload size"; those
sections replace older notes here calling both unbuilt. **Every v1 box was ticked before
`V1_Tasks.md` was removed.**

The one thing missing Redis genuinely costs: the frontend's rate limiter counts per
serverless instance rather than globally. That is a documented approximation, not a gap to
close inside v1's constraints — and **v2 does not close it either**, since Redis stays out of
scope. Adding Postgres does not make it a candidate fix: a per-request DB round trip on the
hot execute path is a worse trade than the approximation.

@collab-code-editor/AGENTS.md
