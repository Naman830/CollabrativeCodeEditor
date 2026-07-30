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
- `collab-code-editor/app/lib/clerkIdentity.ts` — the one boundary between Clerk and the app; nothing else imports `useUser` or `useAuth`. Also exports `useClerkToken()`, the sanctioned way an account ID reaches the sync server
- `collab-code-editor/app/lib/monacoLoader.ts` — points `@monaco-editor/react` at the npm package so no global AMD loader is installed
- `collab-code-editor/app/components/CodeEditor.tsx` — the room screen. **Composition only**: it holds `language`, `code` and the Monaco instance, and hands everything else to the hooks and panels below
- `collab-code-editor/app/hooks/useCollabRoom.ts` — the whole client-side Yjs stack (doc, provider, awareness, Monaco binding, the shared `execution` map and the stale-run watchdog), plus the peers/toasts it mirrors into React
- `collab-code-editor/app/hooks/useCodeRunner.ts` — the Run button: the POST to `/api/execute` and the shared-map write, including the `runId` staleness check
- `collab-code-editor/app/hooks/useCopyToClipboard.ts` — copy + the transient "copied" flag, with the non-secure-context fallback
- `collab-code-editor/app/lib/executionState.ts` — the `ExecutionState` union, the map/key names, `STALE_RUN_MS`, and `isFailedRun()`; imported by the hooks *and* the output panel
- `collab-code-editor/app/lib/cursorStyles.ts` — the remote-cursor `<style>` block; the only thing that writes a peer colour into CSS
- `collab-code-editor/app/lib/download.ts` — Save, in full: a Blob and a throwaway `<a download>`, nothing else. Shared with `/profile`'s Download button since 7.4
- `collab-code-editor/app/components/RoomChrome.tsx` — the room's single chrome bar (room id + sync dot, presence, theme, Save, Run). Replaced `EditorToolbar.tsx` and `UserBar.tsx`, which were two full-width rows
- `collab-code-editor/app/components/EditorPane.tsx` — Monaco, and only Monaco. `memo`'d, and the file that documents why it must never be keyed, conditionally rendered, or moved between parents
- `collab-code-editor/app/components/EditorTabBar.tsx` / `OutputPanel.tsx` / `PanelStrip.tsx` / `icons.tsx` — the chrome around Monaco; presentational, no Yjs. `PanelStrip` is the shared tab strip and exports `PANEL_STRIP_HEIGHT`
- `collab-code-editor/app/components/ResizeHandle.tsx` — the drag divider; wraps `react-resizable-panels`' `Separator`
- `collab-code-editor/app/hooks/useRoomLayout.ts` — split orientation, persisted sizes, output-collapsed state, and the narrow-screen override
- `collab-code-editor/app/components/JoinRoomPrompt.tsx` — the room's name prompt, and the only room-side reader of Clerk
- `collab-code-editor/app/room/[roomId]/page.tsx` — dynamic room route; `roomId` is the Yjs document name
- `collab-code-editor/app/components/RoomGate.tsx` — decides whether a room may be entered at all, *before* the editor (and therefore the socket) exists
- `collab-code-editor/app/lib/rooms.ts` — the client's view of room lifetime: `WS_URL`, the derived HTTP base, `createRoom()`, `checkRoom()`
- `collab-code-editor/app/lib/user.ts` — the entire user model: palette, name sanitizing, and identity as an external store
- `collab-code-editor/app/lib/awareness.ts` — `readPeers()`, the one boundary that turns hostile remote awareness state into values the UI may render
- `collab-code-editor/app/lib/languages.ts` — the one supported-language enumeration: dropdown labels, file extensions, and the Save filename; shared by the editor and the execute route
- `collab-code-editor/app/components/PresenceStack.tsx` — presence as an overlapping avatar stack; renders only what `readPeers` returned
- `collab-code-editor/app/components/IdentityDialog.tsx` — the name/colour prompt, shared by the create and join flows
- `collab-code-editor/app/globals.css` — the whole design system: the light and dark token values, and the `@theme inline` block that turns them into Tailwind utilities
- `collab-code-editor/app/lib/ui.ts` — the shared button/card/input class strings. The one place a button style is written; safe to import from both server and client components
- `collab-code-editor/app/lib/theme.ts` — the `Theme` union, the storage key, and `THEME_SCRIPT`, the no-flash inline script
- `collab-code-editor/app/lib/monacoThemes.ts` — `collab-light` / `collab-dark`, whose backgrounds match `--code-bg`
- `collab-code-editor/app/components/ThemeProvider.tsx` / `ThemeToggle.tsx` — theme as an external store, and the three-way Light/System/Dark control
- `collab-code-editor/app/components/AppProviders.tsx` — `ThemeProvider` wrapping `ClerkProvider`, so Clerk's `appearance` can follow the theme
- `collab-code-editor/app/components/SiteNav.tsx` — the top bar for every screen that is not the room
- `collab-code-editor/app/not-found.tsx` / `error.tsx` / `global-error.tsx` — the root 404, the root error boundary, and the layout-failed page that renders its own `<html>`
- `collab-code-editor/app/icon.svg` — the favicon, via Next's file convention
- `collab-code-editor/app/lib/execution.ts` — the cap on what may be *sent* for execution (`MAX_CODE_BYTES`), shared by the client's pre-flight check and the route's 413
- `collab-code-editor/app/lib/rateLimit.ts` / `server/rateLimit.js` — the same in-memory sliding-window limiter, once per workspace
- `collab-code-editor/app/api/execute/route.ts` — server-side proxy to Piston; also where the sandbox-side execution limits live
- `server/yjsConnection.js` — the only place that speaks the Yjs wire protocol; also the gate that refuses connections to rooms that don't exist, and where a `?token=` becomes a member session
- `server/rooms.js` — the one authority on whether a room exists, and the only thing that ever deletes one. `destroyRoom()` is the single destroy site and therefore the one place a snapshot is *taken* — since 7.5 it hands that snapshot to `snapshotQueue.js` rather than writing it
- `server/snapshotQueue.js` — the one place that decides *when* a snapshot is written: the concurrency cap, the per-creator-IP pacing, and the shutdown drain. Nothing else may call `db.saveDeadRoom()`
- `server/roomState.js` — what a room *was*, as opposed to whether it exists: `created_at`, the verified-member set with its connected-time and did-edit accounting, the accumulated participant list, and `buildSnapshot()`
- `server/clerkAuth.js` — the one place a Clerk token becomes a user ID. Never refuses a socket
- `collab-code-editor/prisma/schema.prisma` — the authority on the `dead_rooms` table's shape, and the only place it is described declaratively
- `collab-code-editor/prisma/migrations/` — the applied SQL history, committed. Two migrations: `20260729084725_init_dead_rooms` and `20260729122125_dead_room_members` (which drops `owner_user_id` and its index), replaying from an empty database
- `collab-code-editor/prisma.config.ts` — Prisma **CLI** config (migrate/generate/studio). Loads `.env.local` by hand and points migrations at `DIRECT_URL`
- `collab-code-editor/app/lib/db.ts` — the one place the app learns about Postgres; server-only, never imported from a `"use client"` module
- `collab-code-editor/app/lib/deadRooms.ts` — the one place the app *reads* `dead_rooms`, and the boundary that turns its `jsonb` columns into renderable values. Also server-only, and the module that enforces "a snapshot is fetched through its membership row or not at all"
- `collab-code-editor/app/profile/page.tsx` / `[deadRoomId]/page.tsx` — the listing and one read-only snapshot; both async Server Components that gate on `await auth()`
- `collab-code-editor/app/profile/error.tsx` / `[deadRoomId]/not-found.tsx` — "the database is unreachable" and "that snapshot isn't yours", kept distinct from each other and from an empty profile
- `collab-code-editor/app/components/ProfileShell.tsx` — the profile chrome: page frame, the shared panel, and the signed-out gate. Carries no database import, because `error.tsx` is a Client Component and imports from it
- `collab-code-editor/app/components/SnapshotFile.tsx` / `SnapshotActions.tsx` / `DeadRoomCard.tsx` — the `<pre>` code view, its Copy/Download buttons (the only client-side code on `/profile`), and one listing row
- `server/db.js` — the sync server's whole database surface: one `pg` pool and one INSERT, no ORM

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
fatal-signal line from stderr, and `components/OutputPanel.tsx` renders the notice in amber
under the output. `notice` is optional on `ExecuteSuccess` because older records may still sit in a
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
all created and destroyed inside one effect keyed on `roomId` *and the local user*, in
`hooks/useCollabRoom.ts`. **That is why it is one hook and not several**: the pieces share a
single teardown, so splitting the doc, the provider and the binding into separate hooks would
hand each its own cleanup order and reintroduce the destroy-a-doc-nothing-recreates bug. Do not
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

**`/room/[roomId]` used to return HTTP 500 on every request. It no longer does — but the
mechanism that caused it is still live, so keep the guard.** `lib/monacoLoader.ts` imports
`monaco-editor` at module scope, which touches `window`, so the chain
`RoomGate.tsx → CodeEditor.tsx → monacoLoader.ts` threw
`ReferenceError: window is not defined` whenever the route was server-rendered. React
recovered on the client, so every feature worked and the fault was invisible from a browser.
The UI redesign fixed it the sanctioned way: `RoomGate.tsx` now loads the editor through
`dynamic(() => import("./CodeEditor"), { ssr: false })` at module scope, which keeps Monaco
off the server **without** reintroducing the CDN AMD loader that file exists to avoid (see
"Accounts (Clerk)"). `ssr: false` is **illegal in a Server Component** in Next 16
(`lazy-loading.md`: *"you will see an error if you try to use it in Server Components"*),
which is exactly why the boundary lives in `RoomGate.tsx` — already `"use client"` — and not
in `app/room/[roomId]/page.tsx`.

Two things follow, and both are cheap regression tests:

- `curl -o /dev/null -w '%{http_code}' localhost:3000/room/<id>` must answer **200**, as must
  `/profile`. A 500 means something dragged Monaco back into a server graph — check for a new
  static `import` of `CodeEditor`, `monacoLoader` or `monacoThemes` from a Server Component.
- `curl -s localhost:3000/room/<id> | grep -c monaco` must be **0**. The status code alone
  stopped being sufficient the moment the route started succeeding.

That fix is also what makes the no-flash theme script work on this route: the script lives in
the root layout's `<head>`, and a route that 500s never ships one.

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

The user bar and `lib/cursorStyles.ts`'s `renderAwarenessStyles` (the remote-cursor `<style>`
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

Signing in is **optional and additive**: every guest path from v1 works untouched. Since 7.3 an
account also buys persistence — a room you worked in is snapshotted to `dead_rooms` when it
dies (see "Dead-room snapshots"). Guests still store nothing at all.

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
`hooks/useCollabRoom.ts` lists its fields one by one and must never become `{...user}`: awareness is
peer-controlled, so a broadcast account ID is a claim anyone can forge, and 7.3 keys saved
room snapshots on an account. Sourcing that from awareness would let a passing guest write a
room's code into a stranger's profile — the same class of hole as the CSS-colour injection
`readPeers` guards, but the blast radius is another user's stored data.

**7.3 resolved this with `verifyToken` from `@clerk/backend` on the socket.** The client appends
`?token=` (built by `useClerkToken()` in `lib/clerkIdentity.ts`), and `server/clerkAuth.js`
verifies it. `server/yjsConnection.js` already discarded the query string
(`req.url.slice(1).split("?")[0]`), which is the same derivation `setupWSConnection` uses by
default, so the doc name was unaffected. Two rules hold that design up:

- **Verification never refuses the socket.** A bad, expired or missing token, an unset
  `CLERK_SECRET_KEY`, and a Clerk outage all mean the same thing: no membership recorded, room
  otherwise untouched. Gating the socket on Clerk would repeat, one layer down, the bug this
  section already documents — a deep-linked room that could not be joined at all. A missing
  token costs a profile entry; a missing socket costs the room.
- **Verification starts only after the room gate passes**, so a probe loop against dead room
  IDs cannot force a JWKS round trip per attempt. The WebSocket path is not covered by
  `POST /rooms`' rate limiter.

**Never log `req.url`.** Since 7.3 it carries a Clerk session token. Log `docName` instead, and
log verification failures as `err.reason ?? err.message` — never the input.

**A Clerk session token lives ~60s, and y-websocket freezes the URL at construction.**
`params` are serialised into `this.url` once, in the constructor, but `setupWS` re-reads
`provider.url` on every dial. So `useCollabRoom` rewrites `provider.url` with a fresh token on
`status === "disconnected"`; without that, every reconnect after the first minute carries a
dead token and that user's connected time silently stops accruing mid-session. The base is
taken from `provider.url.split("?")[0]` rather than rebuilt from `WS_URL`, so it agrees with
y-websocket's own construction (trailing-slash stripping included).

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

**Automated sign-in needs two things the UI does not tell you.** The dev instance has
Cloudflare Turnstile on **sign-up**, so a driven browser can never complete one — create the
user through Clerk's Backend API (`POST https://api.clerk.com/v1/users` with
`CLERK_SECRET_KEY`) instead, which bypasses it and marks the email verified. Then sign-*in*
from a fresh browser profile still stops at `signIn.status === "needs_client_trust"` ("You're
signing in from a new device"), which wants an emailed code — a `+clerk_test@example.com`
address accepts the fixed code `424242` and sends no mail. Clerk's OTP control is a row of
**unnamed** single-character inputs, so match it on `input[inputmode="numeric"]`, not a name.

**Clerk loads on `localhost` and silently does not on `127.0.0.1`.** They are the same server
but not the same origin, and the dev instance only allows the former. The failure has no error
banner: `window.Clerk` exists with `loaded: false` forever, `useClerkIdentity()` stays
`{ready: false}`, and the landing page simply renders without its Sign in / Sign up buttons —
which reads as a broken page rather than a hostname problem. Always drive the app at
`http://localhost:<port>`.

**Clerk session tokens can be minted server-side, which makes the sync server testable without
a browser at all.** `POST /v1/sessions` with `{user_id}` then
`POST /v1/sessions/{id}/tokens` yields a real JWT that `verifyToken` accepts. That is how 7.3's
membership rules were verified headlessly; the browser pass then only had to confirm the client
actually sends one.

**The identity dialog opens *before* the room exists.** "Create a new room" opens the dialog,
and `createRoom()` only runs when it is submitted, so the navigation to `/room/<id>` comes after
"Create & Enter" — not before. Its inputs carry **no `id` or `name`**; match them on
`autocomplete="given-name"` / `"family-name"`. And Monaco renders spaces as non-breaking
spaces, so assertions against editor text must normalise ` ` first.

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

**`ClerkProvider` lives in `components/AppProviders.tsx` (a Client Component), not in
`app/layout.tsx`, and `appearance.variables` must be literal hex strings.** Both halves of
that are forced by the light/dark theme. Clerk *parses* these colours at runtime to derive
its own shades and alpha variants (`@clerk/shared/dist/color.mjs` exports
`stringToHslaColor` / `hexStringToRgbaColor`), so a `var(--panel)` reference is not a
parseable colour and Clerk falls back to broken defaults — which means the values have to
change with the theme, which means only the client can supply them.

**Moving the provider client-side costs nothing here, and that is measured rather than
assumed.** `@clerk/nextjs`'s *server* `ClerkProvider`
(`dist/esm/app-router/server/ClerkProvider.js`) computes `initialState` **only when passed a
`dynamic` prop**, which this app has never done — so `initialState` was already `undefined`
and the server provider already delegated straight to `ClientClerkProvider`. There is no SSR
auth state to lose. Keyless mode is handled on the client path too
(`LazyCreateKeylessApplication`). `app/layout.tsx` stays a Server Component and just renders
`<AppProviders>`. Keep `CLERK_DARK`/`CLERK_LIGHT` in that file in step with `globals.css`.

## Design system and theming

`app/globals.css` holds the whole system: raw token values on `:root` (light) and `.dark`,
surfaced to Tailwind through **`@theme inline`**. `app/lib/ui.ts` holds the class strings
built from them.

**`@theme inline` is load-bearing, not stylistic.** A plain `@theme` copies each value into
the generated utilities at build time, so `bg-panel` would bake in the light hex and the
toggle would do nothing. `inline` makes the utility emit `var(--panel)` instead, so flipping
one class on `<html>` re-resolves every utility at once. This is why the tokens are declared
twice: raw custom properties for the values, `@theme inline` for the Tailwind names.

**Tailwind v4's `dark:` variant follows `prefers-color-scheme` by default, which is wrong for
a manual toggle** — someone who picks light on a dark OS would still get every `dark:` rule.
`@custom-variant dark (&:where(.dark, .dark *))` re-points it at the class. `"system"` is
resolved to a concrete class in JS rather than left to CSS, so there is exactly one source of
truth. There is very little `dark:` in the codebase as a result: components use semantic
tokens (`bg-panel`, `text-fg-muted`) and get both themes for free. Reach for `dark:` only
where a value genuinely is not a token — the modal scrim in `IdentityDialog` is the one case.

**The no-flash script must be an inline `<script>` in `<head>`, and nothing React does can
replace it.** By the time hydration runs the browser has already painted the body once, so a
provider-based fix flashes the wrong theme at everyone who chose the non-default. This is the
pattern Next documents for exactly this problem
(`node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`,
"Themes"). `suppressHydrationWarning` on `<html>` is **required** rather than cosmetic: the
script writes `class="dark"` before React hydrates, and without it React treats that as a
mismatch, re-renders from the nearest boundary and undoes it.

**Theme state is an external store, for the same two reasons identity is** (see "Identity is
read via `useSyncExternalStore`"): the server cannot know what is in `localStorage`, so the
server and client snapshots must legitimately differ; and React 19's
`react-hooks/set-state-in-effect` rule rejects the obvious
`useEffect(() => setTheme(readStoredTheme()))`. The store is module scope, so one
`matchMedia` listener serves every consumer and `"system"` keeps tracking the OS live.

**Monaco is themed by prop, never by remount.** `lib/monacoThemes.ts` registers
`collab-light`/`collab-dark` in `<Editor beforeMount>`, and `EditorPane` switches the `theme`
prop; `@monaco-editor/react` turns that into `monaco.editor.setTheme()`. The custom themes
exist because the built-in `vs`/`vs-dark` backgrounds (`#ffffff`, `#1e1e1e`) match neither
`--code-bg`, so the editor would sit as a visibly different shade inside its own panel.

**A colour that is *not* a token, on purpose:** the `#141414` avatar text in `PresenceStack`
and `IdentityDialog`. It is dark text on the peer's own pastel from `CURSOR_COLORS`, which
are Material 300/400 mid-tones legible in both themes — so it must not follow the theme.
`lib/cursorStyles.ts` needs no theme work for the same reason.

## The resizable room layout

`react-resizable-panels` **v4**, which is a different library from the v2/v3 API almost every
recipe online describes: it exports `Group` / `Panel` / `Separator`, not
`PanelGroup` / `Panel` / `PanelResizeHandle`; the prop is `orientation`, not `direction`;
`autoSaveId` **does not exist**; and a layout is `{ [panelId]: number }`, not `number[]`.

**The one invariant that matters: `<Editor>` must never unmount.** `useCollabRoom`'s master
effect is keyed on the Monaco instance, so a remount destroys the `Y.Doc`, the provider, the
awareness handler and the `MonacoBinding` — wiping the room's shared output *for everyone*,
re-firing every join toast, and orphaning y-monaco's cursor decorations. Verified against the
v4.12.2 source: `Group` and `Panel` both render `children` unconditionally, `orientation` only
flips the container's flex-direction, and collapsing a panel changes nothing but inline
`flex-grow`/`flex-basis`. Nothing the library does can unmount the editor. What *would*:

- two `<Group>`s behind a ternary (`orientation === "horizontal" ? <Group…> : <Group…>`),
- any `key` on the path from `CodeEditor` down to `EditorPane`,
- conditionally rendering a pane — which is why the phone layout collapses a panel instead of
  switching tabs.

**Test it by asserting the shared output survives, not by looking at the layout.** Run
something, then drag, flip orientation, collapse and expand. If the output panel resets to
"Output will appear here…" or a join toast re-fires, the editor remounted. Checking a second
tab is what makes it unambiguous.

**`Panel`'s `className` lands on its *inner* div, and that div ships an inline
`overflow: auto`.** No Tailwind class beats an inline style, so suppressing it needs
`style={{ overflow: "hidden" }}` — otherwise the panel grows its own scrollbar next to
Monaco's.

**`min-h-0` twice, for two different reasons.** On the panel root it is what lets the pane
shrink below its content when the split is dragged small. On `OutputPanel`'s scroll body it is
what makes `overflow-auto` engage at all: `flex-1` alone leaves `min-height: auto`, i.e. the
content's height, so a long stack trace pushes the panel open instead of scrolling inside it.

**Sizes are deliberately not React state.** `Group` exposes `onLayoutChange` (every
pointermove) and `onLayoutChanged` (once, on release); only the second is wired up, and it
writes through a ref. A re-render of `CodeEditor` mid-drag would hand `<Editor>` a fresh
element and defeat `Panel`'s child bailout. For the same reason `handleRun` and `handleSave` —
both new functions on every keystroke, since they close over `code` — travel only *up* into
`RoomChrome`, never down into the editor panel.

**Numeric sizes are pixels; bare-string sizes are percentages.** `minSize="25"` is 25%,
`collapsedSize={36}` would be 36px. The output panel collapses to `PANEL_STRIP_HEIGHT`
(`"2.25rem"`) when stacked, so the collapsed panel *is* its own tab strip and keeps its own
restore button. Side by side there is nothing legible to leave in a 36px column, so it
collapses to `"0"` and `CodeEditor` lends it a restore button in the editor's tab strip.
Change `PANEL_STRIP_HEIGHT` and the collapsed height must change with it, or collapsing hides
the only control that undoes it.

**Free from `Separator`, so do not rebuild any of it:** `role="separator"`, `tabIndex=0`, the
full `aria-value*` set, arrow keys (±5%), Home/End, Enter to collapse or expand a collapsible
neighbour, F6 to cycle handles, and double-click to reset. Drag state arrives on the
`data-separator` attribute — `inactive | hover | active | focus | disabled` — which is what
the styling keys off. The library also owns the drag cursor (it injects a global `!important`
rule) and inflates the hit rect via `Group`'s `resizeTargetMinimumSize`, so a 1px divider is
already grabbable on a touchscreen and needs no padding-span trick.

**Do not use the `useDefaultLayout` hook.** Its `storage` parameter defaults to a bare
`localStorage` reference evaluated during render, so it throws outright on the server, and its
`getServerSnapshot` is literally the same function as `getSnapshot`, which guarantees a
hydration mismatch on every panel at once. `useRoomLayout` persists one JSON blob itself.

**Phones get a forced stack, not a tab switcher.** `useRoomLayout` watches
`(max-width: 767px)` and overrides the orientation while leaving the stored *preference*
untouched, so rotating back to landscape restores the real choice; the orientation control is
not rendered at that width. A tab switcher was rejected because it either unmounts the editor
or hides it with `display: none`, which reports 0×0 to `automaticLayout`'s ResizeObserver and
can bring Monaco back blank.

**The room page is `h-dvh`, not `h-screen`.** `100vh` on mobile excludes the URL bar, which
used to clip a corner off a fixed-height output strip and would now hide the collapsed output
bar — the one control that brings the output back.

## Room lifetime

A room has three stages, and `server/rooms.js` is the only module that knows about any of
them:

```
reserved ──connect──► live ──last socket closes──► grace (10s) ──► destroyed
   │                    ▲                             │
   └─5 min, unclaimed───┘  reconnect cancels ─────────┘
```

`roomExists()` is true for all three stages, which is what makes a page refresh survive.

Since 7.5 there is a fifth state that the diagram cannot show, because it belongs to no room:
**destroyed-but-unwritten.** A snapshot handed to `server/snapshotQueue.js` outlives the room
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
into existence, empty. `server/yjsConnection.js` refuses unknown rooms *before* calling
`setupWSConnection`, which is also what stops an old tab, reconnecting after an eviction or a
server restart, from silently resurrecting the room it remembers.

**Refusal is a post-handshake close with code 4404, not a rejected upgrade.** A rejected
upgrade reaches the browser as an opaque error with no code attached, and the client needs to
tell "this room is gone" (stop retrying, show the closed screen) from "the network blipped"
(keep retrying). The constant is `CLOSE_ROOM_NOT_FOUND`, duplicated in
`server/yjsConnection.js` and `hooks/useCollabRoom.ts` because the two workspaces share no code.
Note y-websocket keeps reconnecting forever on its own, so the client's handler must call
`provider.disconnect()` — that sets `shouldConnect = false`, which is the only thing `setupWS`
checks before re-dialling.

**`GET /rooms/:roomId` always answers HTTP 200 — existence is the `exists` field
in the body.** There is no 404 for a dead room, which is what `lib/rooms.ts`'s `checkRoom`
relies on: a non-`ok` response means *unreachable*, and only `{"exists": false}` means
*missing*. Anything asserting on the status code (a health check, a test) will read every
dead room as alive.

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
rides entirely on Yjs, not a new server message: `hooks/useCollabRoom.ts` puts a second shared type,
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
itself rather than clobbering the winner. `useCodeRunner`'s `stale()` check covers this, plus
the case where the effect torn down (room switch/unmount) while the fetch was in flight, via
the `docRef` ref `useCollabRoom` returns (a ref, not state — see the Yjs-lifecycle gotcha below: hoisting the doc into
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

## Dead-room snapshots (task 7.3)

When a room is destroyed, its final text is written **once** to `dead_rooms`, plus one
`dead_room_members` row per person who earned a copy. `server/rooms.js`'s `destroyRoom()` is
the single site; `server/roomState.js` decides what and for whom. Guest-only rooms — still the
common case — write nothing at all, exactly as in v1.

**Since 7.5, "taken" and "written" are two different moments.** `destroyRoom()` still captures
the room's final state at the instant it dies, and is still the only place that does — but it
then hands the snapshot to `server/snapshotQueue.js`, which decides when the INSERT actually
runs. Everything below about *what* is captured and *for whom* is unchanged; what moved is the
timing. Two consequences worth carrying into any change here: the snapshot carries its own
`diedAt` rather than letting the INSERT default to `now()`, and `db.saveDeadRoom()` must not be
called from anywhere but the queue, or the concurrency cap stops meaning anything. See "The
snapshot write queue" under "Rate limiting and payload size".

**Who a dead room belongs to.** Every verified signed-in participant who **stayed 60s**
(`MEMBER_MIN_CONNECTED_MS`) **and actually edited the document**. There is no owner and no
ownership transfer. The two halves do different jobs and neither is redundant: the timer stops
a drive-by, and **the edit check is the only thing that stops a lurker**, since anyone who
leaves a tab open passes 60s. `tasks.md` §6.1 originally said "connected while the document was
non-empty" instead — that is unimplementable here, because `useCollabRoom` seeds `DEFAULT_CODE`
on `sync`, so every room is non-empty milliseconds after the *first* client arrives and the
clause filters nothing.

**Yjs hands you the WebSocket as the transaction origin, and that is what makes "did they
edit" cheap.** y-websocket's `messageListener` calls
`syncProtocol.readSyncMessage(decoder, encoder, doc, conn)` — the 4th argument is the origin —
so `doc.on("update", (_u, origin) => …)` identifies the sending socket, and a `conn -> userId`
map turns it into attribution. Use `doc.on("update")` rather than a `Y.Text` observer: `Doc.destroy`
calls `super.destroy()`, which removes the Doc's own observers, while a `Y.Text` handler
survives destruction — and the origin is only available on the Doc event anyway.

**Verification is asynchronous, so early edits arrive unattributed. This silently lost
snapshots.** The first `verifyToken` of a process fetches Clerk's JWKS (~200ms measured; ~1ms
once cached), while a client syncs and starts typing in ~50ms. Every edit in that window found
no entry in `connUsers`, so `didEdit` stayed false and the user failed the threshold. It
reproduced **consistently for the first signed-in user after every restart** and vanished for
everyone afterwards, which makes it look like flakiness rather than a bug. `roomState.js`
therefore keeps a `pendingEdits` set of sockets that edited before their token resolved, and
`beginMemberSession` drains it. `forgetConn` clears it for *every* closing socket, verified or
not, because a guest's entry would otherwise sit there for the room's whole life.

**`doc.destroy()` synchronously re-fires the awareness `update` handler one last time.**
`y-protocols` registers `doc.on('destroy', () => this.destroy())`, and `Awareness.destroy()`
calls `setLocalState(null)` — which emits `update` — **before** `super.destroy()` drops
listeners. Two consequences: every handler in `roomState.js` is **lookup-only** and bails on a
missing room (a get-or-create there resurrects state for a room that was just destroyed, and
nothing would ever delete it again), and `deleteRoomState()` runs **after** `doc.destroy()`,
never before.

**Awareness is already empty when a room dies, so `participants` must be accumulated.**
y-websocket's `closeConn` calls `removeAwarenessStates()` for every socket that closes, so by
eviction time `getStates()` returns nothing. There is no later moment at which "who was here"
is recoverable. The accumulator dedupes on **`name|color`, never `clientID`** — a refresh
inside the grace window mints a new `Y.Doc` and therefore a new clientID, so one person who
refreshed twice would appear three times. It also walks only the `{added, updated}` clientIDs
the event carries: awareness `update` fires on *every cursor move of every peer*, so a full
`getStates()` rescan would re-walk the participants map on every keystroke in the room.

**Two tabs are two collaborators but one member.** The client-side sessionStorage split (see
"Identity storage is split on purpose") deliberately makes a second tab a separate
collaborator with its own cursor and colour; server-side, both sockets verify to the same Clerk
ID and reference-count into one member. Seeing two chips in the user bar and one
`dead_room_members` row is correct, not a bug.

**The member refcount has three ways to corrupt itself, and each loses data silently.**
`sessionStartedAt` is set only on the 0→1 transition (otherwise a second tab opening at t=90s
resets the clock); it uses `Math.min` because verification resolves *out of socket order* —
the first connection pays the JWKS round trip and later ones hit the cache, so a socket opened
at t=0 can register after one opened at t=100ms; and `endMemberSession` must run at most once
per socket, guarded by an `ended` flag at the call site rather than `Math.max(0, …)`, which
would hide a negative count while still stranding that user's time for the room's life.

**Never read `connectedMs` directly — go through `elapsedMs(member, now)`.** At the SIGTERM
flush every member is still connected, so `connectedMs` is missing the entire live session.
Reading it raw fails every member on every deploy — precisely the case the flush exists for.

**The shutdown flush destroys live rooms too, and that is the point.** Documents are in-memory
only and the registry dies with the process, so at SIGTERM a live room *is* a dead room that
has not noticed. Flushing only rooms already inside their grace window would save the rooms
nobody was using and lose every room someone was working in, on every deploy. Shutdown closes
sockets with **1012 (Service Restart), not 4404** — the client treats 4404 as permanent and
stops retrying, which is exactly wrong for a redeploy — and `/health` answers 503 while
draining so Railway stops routing. Since 7.5 the flush also calls `snapshotQueue.releasePacing()`
**before** the destroy loop and `snapshotQueue.destroy()` after the deadline race; both are
explained under "The snapshot write queue", and without the first a queue with no live rooms
behind it is lost outright.

**`destroyRoom` must not be `async`, and nothing may be awaited before `docs.delete()`.** An
await there leaves a window in which `roomExists()` still answers true, so a client can
reconnect into a room whose snapshot is already committed — a live room whose `room_id` is
burned by the `UNIQUE` constraint, meaning its real snapshot is later swallowed by
`ON CONFLICT DO NOTHING`. That same synchronous `docs.delete()` is what makes the function
idempotent against the eviction timer racing the flush.

**Destruction is unconditional; snapshotting is best-effort.** An uncaught throw inside the
eviction `setTimeout` is an uncaught exception that kills the process and every other live
room. Snapshot building is wrapped in `try/catch`, and `doc.destroy()` + `deleteRoomState()`
sit in a `finally`.

**Two ways the snapshot text can silently poison the INSERT.** A **NUL byte** (`\u0000`) cannot be stored in a
Postgres `text` or `jsonb` value at all — Monaco will not type one but a paste can carry it —
so it is stripped. And truncation must go through `Buffer.subarray(...).toString("utf8")`,
never a byte index into the JS string: a hand-rolled slice can cut a surrogate pair in half,
`JSON.stringify` then emits a lone `"\ud83d"`, and Postgres rejects the whole statement with
`unsupported Unicode escape sequence`. Node's decoder substitutes `U+FFFD` instead. Only
reachable with emoji or CJK near the 256 KB cap — i.e. never by accident in testing.

**`pool.query("BEGIN")` is not a transaction.** With `max: 3` the BEGIN, the INSERTs and the
COMMIT can each land on a *different* pooled connection, so the inserts run outside the
transaction and the COMMIT commits nothing. It fails silently, because the rows still appear.
`saveDeadRoom` checks out a client with `pool.connect()`, and `client.release()` in a `finally`
is mandatory — a leaked client out of a pool of three blocks the next two snapshots for
`connectionTimeoutMillis` and then fails them.

**Read `RETURNING id`, not `rowCount`.** With `ON CONFLICT DO NOTHING` a conflict yields an
empty `rows` array, and the id is what the members insert needs anyway. On a conflict the
members are deliberately **not** topped up: the first write is authoritative and a snapshot is
never updated (§6.1).

**`DB_CONNECT_TIMEOUT_MS` has to cover a Neon cold start, not just a TLS handshake.** The pool
is always cold at SIGTERM (the process is idle between evictions, `idleTimeoutMillis` is 30s)
and Neon autosuspends an idle branch. Measured ~750–900ms warm, but **over 5s against a
suspended branch** — a 5s ceiling was observed failing outright with `Connection terminated due
to connection timeout`. Hence 10s, under a 20s flush budget.

**`jsonb` does not preserve object key order.** It normalises to shortest-key-first, so
`{filename, content}` reads back as `{content, filename}`. Harmless, but any test comparing
serialised JSON must compare structurally instead.

**Nothing that reaches a column may carry a NUL or an unpaired surrogate.** NUL cannot be
stored in `text` or `jsonb` at all; a lone surrogate is worse, because it fails late and
loudly — `JSON.stringify` happily emits a bare `\ud83d`, and Postgres rejects the **whole**
statement with `unsupported Unicode escape sequence`, so one bad character in one
participant's name loses the room's code too. Both are stripped by `stripUnstorable` in
`server/roomState.js`, applied to every path. Two traps this closed, both found in 7.4:
`sanitizeName`'s cut counted UTF-16 code units and could halve a surrogate pair — the name cut
is now by **code point**; and `snapshotText` only repaired the document on its *truncating*
branch, where `Buffer.toString("utf8")` substitutes U+FFFD, so a lone surrogate in a document
**under** 256 KB was returned untouched. Monaco types neither character, but awareness is
peer-supplied and a paste or a raw Yjs client can carry both.

## The profile page (task 7.4)

`/profile` is the only reader of `dead_rooms`, and the only page in the app that is
protected. Everything under `app/profile/` is a Server Component except `SnapshotActions` and
`error.tsx`; the code view itself ships no JavaScript.

**A `DeadRoom` is never fetched by its id.** Both queries in `app/lib/deadRooms.ts` start from
`deadRoomMember` keyed on the *viewer's* Clerk user ID and reach the room through the relation,
so a snapshot the viewer holds no membership row for is not hidden by a filter someone
remembered to add — it is unfetchable. §6.1 puts one room on several profiles, so there is no
ownership column that could do this job instead. The detail lookup is `findUnique` on the
composite primary key `(user_id, dead_room_id)`, which makes the authorization check and the
index lookup the same query. Keep it that way: a `deadRoom.findUnique({where:{id}})` with a
membership check bolted on afterwards is one forgotten `if` away from serving a stranger's code.

**The URL carries `dead_rooms.id`, not `room_id`,** so the membership key and the path segment
are the same value. It also keeps a dead snapshot's URL from sharing an id with a live
`/room/<id>`. Because `id` is a Postgres `uuid`, a malformed segment does *not* come back as
"not found" — it reaches the driver and 500s on `invalid input syntax for type uuid`, so
`DEAD_ROOM_ID` rejects it before the query. And `notFound()` answers identically for "no such
row" and "not yours", or the URL becomes an oracle for which snapshots exist.

**There is no `loading.tsx` under `app/profile/`, and adding one breaks the 404.** A Suspense
boundary in the parent segment also wraps `[deadRoomId]`; once a response starts streaming its
status is already sent, and Next then serves the not-found UI under a **200**. The query is a
single indexed lookup, so a spinner is not worth a wrong status code.

**`error.tsx` exists because "the database is unreachable" is not "you have no rooms".** Neon
autosuspends an idle branch, so a cold start is a routine way to fail here, and an empty-looking
profile would be a lie the user cannot check — the same `missing` vs `unreachable` split
`RoomGate` draws for a room. It takes Next 16.2's **`unstable_retry`**, not `reset`: `reset`
was demoted to "clear the error and re-render the children *without re-fetching*", which is the
wrong half for a failed query. Both props are passed; only `unstable_retry` re-runs the server
render. Verified by starting a production build against a dead `DATABASE_URL`.

**No `export const dynamic = "force-dynamic"`, and none is needed.** Clerk's `auth()` reads
`headers()` internally, which opts the route into dynamic rendering on its own — `next build`
lists both profile routes as `ƒ`. Clerk also throws `ClerkUseCacheError` if `auth()` is called
inside a `use cache` scope, which is one more reason `cacheComponents` must stay off: enabling
it would also switch navigation to `<Activity>`-based state preservation, and the room route
depends on a real unmount to tear the Yjs stack down.

**Auth is checked in the page, never in `proxy.ts`.** `clerkMiddleware()` stays callback-free
so `/`, `/room/*` and `/api/execute` remain public, and Clerk's own `createRouteMatcher`
deprecation note says to "move auth checks into each page, layout, API route, or Server
Function that accesses protected data". A signed-out visitor gets an in-page gate with a
`SignInButton mode="modal"` rather than a redirect: this app has no `/sign-in` route, so
`auth.protect()` would eject them to Clerk's hosted Account Portal, and a bare `redirect("/")`
turns a shared `/profile` link into a silent bounce.

**The code view is a `<pre>`, and Monaco must not come back.** An editor is the one widget on
this site that means "you can type here", which is the opposite of what §7.4's last bullet
asks for; there is nothing to highlight while `language` is null; and `lib/monacoLoader.ts`
imports `monaco-editor` at module scope, which is why that import must stay out of this
route's graph. **An earlier version of this paragraph said the regression test was `/profile`
answering 200 while `/room/<id>` answered 500. That contrast no longer exists** — the UI
redesign fixed the room route with a `dynamic(..., { ssr: false })` boundary in `RoomGate`, so
both now answer 200. The replacement check is
`curl -s localhost:3000/room/<id> | grep -c monaco`, which must be **0**; see the
`/room/[roomId]` gotcha above. Line numbers are one string in a `sticky left-0` `<pre>`, not
one element per line: a 256 KB snapshot is ~8000 lines, and 8000 gutter spans is 8000 DOM
nodes for numbers nobody selects.

**The listing does not select `files`.** A snapshot is up to 256 KB, so a hundred of them is
~25 MB pulled out of Neon to render metadata cards. That is also why the cards carry no code
preview — a preview needs `$queryRaw` with a `jsonb` substring, not a wider `select`. The list
is capped at 100 rows (`take: LIST_LIMIT + 1`, so the cap can be *detected*) and says so when
the cap bites.

**What the page has to render around, and these are real values, not placeholders.** There is
**no room name** — `dead_rooms` has no name column, so the original `room_id` is the title.
`language` is null on every row and shows as "not recorded"; `is_private` is `false` on every
row and is not rendered at all. Both become meaningful only when §10.1 and §10.3 land.
`participants` is written but deliberately **unread**: nothing on `/profile` renders a peer
name or colour today, and anything that starts to must go through a sanitizing boundary like
`readSnapshotFiles`, never straight from the column.

**Dates are relative on purpose.** "Closed 3 hours ago" and "lasted 12 minutes" are pure
deltas, so the server and the browser agree; a locale- or timezone-formatted absolute date
rendered on the server is a hydration mismatch waiting to happen on a page that otherwise
needs no client JavaScript. The exact instant still travels, in `<time dateTime>` and `title`.

**`TRUNCATION_MARKER` is now the fourth hand-maintained duplication across the workspaces,**
after `rateLimit.js`/`rateLimit.ts`, `CLOSE_ROOM_NOT_FOUND`, and `roomState.js`'s copies of
`sanitizeName`/`HEX_COLOR`. `deadRooms.ts` matches it with `endsWith` — never `includes`, since
a user may have typed that sentence themselves — to show the amber "this room grew past the
256 KB cap" notice. The content is still rendered and copied **verbatim**, so what you see is
what you copy.

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

### The snapshot write queue (task 7.5)

There is a **third** limiter, and it is not an endpoint: `server/snapshotQueue.js` sits between
`destroyRoom()` and `db.saveDeadRoom()`. It is what `tasks.md` §7.5's "rate-limit DB writes the
same way v1 rate-limits room creation" became.

**It defers; it never refuses.** This is the difference that matters, and it is not a
stylistic one. `POST /rooms` can answer 429 because there is a caller standing there to retry.
A snapshot has no caller: the room is already destroyed and its document freed, so a refused
write destroys the only copy of that work. And the legitimate case that trips a per-IP limit is
a **shared NAT** — one office or classroom egress IP closing thirty rooms at 5pm — not an
attacker. So an over-limit snapshot waits its turn. The only thing that discards is the queue's
own memory bound, and it logs loudly when it does.

**The concurrency cap is the part that actually fixed a bug, and it is the reason to keep this
module even if the pacing were removed.** Before it, `destroyRoom()` fired `saveDeadRoom()` and
forgot it, so N rooms dying at once meant N concurrent `pool.connect()` calls against
`db.POOL_MAX` of 3. Everything past the third waits in pg-pool's pending queue, where
`connectionTimeoutMillis` eventually rejects it — and the room is gone, so nothing can retry.
**Measured: 10 rooms dying together, 3 saved, 7 lost**, exactly the pool size. Every redeploy
took this path, because the shutdown flush destroys every room at once. The cap is
`db.POOL_MAX` **exactly**: one less idles a connection for nothing, one more puts a worker back
in the pending queue this exists to keep it out of. If anything else in that process ever uses
the pool, this cap must drop below `POOL_MAX`.

**`died_at` is bound by the writer, not left to the INSERT's `now()`.** Once a write can be
paced, `now()` records when Postgres was reached rather than when the last person left — and
`/profile` both *sorts* its listing on `died_at` and renders `died_at - created_at` as each
room's lifetime, so a deferred room would sort below a later one and claim a longer life.
Verified: 10 rooms paced across ~15s came back with an 8ms `died_at` spread.

**The shutdown flush calls `releasePacing()` before it destroys anything, and that ordering is
load-bearing.** A room that died earlier can be parked behind a pacing timer when SIGTERM
arrives. By then `server.close()` has released the listening handle, Node's signal handles never
anchored the event loop, and the pacing timer is `unref()`'d — so if the flush only set a flag,
Node would exit with those snapshots still in memory. `releasePacing()` pumps *synchronously*,
and the `pool.connect()` sockets it opens are what keep the process alive long enough to finish.
After the deadline race resolves, `destroy()` closes the queue before `db.close()` runs, or the
remainder would be attempted against an ended pool and never settle.

**Every terminal path resolves, including a dropped one.** Those promises live in
`pendingWrites`, and one that never settles makes `flushAndDestroyAll`'s `Promise.race` always
resolve via its deadline branch — turning every shutdown, healthy or not, into a full
`SNAPSHOT_FLUSH_MS` wait.

**The default is 60/min, not the 10 `POST /rooms` uses**, so the sentence at the top of this
section is about *endpoints* only. Ten would be near-useless as a bound and actively harmful as
a delay: room creation is already capped at 10/min/IP, and a snapshot additionally needs a
signed-in member who stayed `MEMBER_MIN_CONNECTED_MS` **and** edited, so the achievable rate per
IP is already ≤10/min at a cost of 60s of connected time per room.

**The creator's IP never leaves memory.** `POST /rooms` is the only moment a room and an address
are ever in the same place — `destroyRoom` has no request and no socket — so `clientKey(req)` is
recorded there, carried on the in-memory room state, and used solely as the pacing key. It is
not a column, `saveDeadRoom`'s INSERT lists its columns explicitly, and the queue's logs print
room IDs and queue depths only. Same rule as the `req.url` logging ban: an address that now
lives in memory for minutes deserves the same care as a token.

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

`hooks/useCodeRunner.ts` checks the same constant from `app/lib/execution.ts` before fetching. That
is a courtesy, not the enforcement — the route is reachable without the UI — but it means an
oversized document never crosses the wire, and it writes the failure into the shared
`execution` map like any other result, since the document is shared and so is the problem.

## Saving (the Save button)

Since 7.4 `lib/download.ts` has a second caller — `/profile`'s Download button, which saves a
dead room's `main.txt`. That does not change anything below: it is still a Blob and an `<a
download>`, still nothing stored, and it is neither a Run nor a Rejoin, which is what §8
forbids on a dead room.

Save is the mirror image of Run: **entirely local**, and deliberately so. `lib/download.ts`
builds a `Blob`
from the editor's current text, clicks a throwaway `<a download>`, and revokes the object URL
— no Yjs write, no request to the server, nothing stored anywhere (v1's core principle:
"saving a file means downloading it to the user's device"). v2 keeps Save local; the only
thing that ever reaches Postgres is the automatic dead-room snapshot, never a Save click. Note
section 10.1 of `tasks.md` changes *what* Save produces once multi-file lands — one file
downloads directly as today, 2+ files zip into `project.zip` via JSZip — but not where it
goes.

It must stay off the shared `Y.Doc`. The language selector is a per-user editing preference,
so two peers looking at the same text can be on different languages, and each has to get
their own extension — verified with two tabs: one on C++ downloaded `main.cpp` while the
other downloaded `Main.java`, same contents. Putting the filename or a "last saved" flag into
shared state would force one peer's choice onto everyone.

**The selector is the file tab, not a toolbar dropdown.** Since the UI redesign it lives in
`EditorTabBar.tsx` as a real `<select>` layered invisibly (`opacity-0`) over the tab, with the
visible `main.py` / `Main.java` label `aria-hidden` beneath it. The filename is derived from
the language by `downloadFileName()`, so making the tab the control that changes it keeps one
idea in one place — and the invisible-native-select trick keeps the mobile picker, the
keyboard contract and the screen-reader semantics for free. Match it in tests on
`select[aria-label="Language"]`; there is no `#language-select` id any more. This is still a
per-user preference and still nowhere near the shared doc — §10.1 moving it to room creation
is unaffected.

**`app/lib/languages.ts` is the only place languages are enumerated.** It holds the dropdown
labels, the Monaco/Piston language ids, and the file extensions; the editor components and
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

## Persistence (Postgres)

**Postgres is the only data store, and it holds exactly one thing**: the `dead_rooms` snapshot
written when a room is destroyed. Nothing on the live path touches it — sync stays in memory,
Save stays local, and the rate limiters stay in-process. Adding Postgres does **not** make a
shared rate-limit counter a candidate: a per-request round trip on the execute path is a worse
trade than the documented per-instance approximation.

The database is **Neon** (`neondb`, `ap-southeast-1`), with a `dev` branch
(`ep-raspy-rice-aosriqt9`) for local work and `main` (`ep-super-star-ao4pfz3z`) for the
deployed site, so local testing never writes rows the deployed `/profile` would read. Both
carry the same single migration. `collab-code-editor/.env.local` and `server/.env` point at
`dev`; Railway and Vercel must point at `main`.

**The Neon database was not empty when 7.2 migrated it, and this is worth knowing before you
trust anything in it.** It held a `Room` table (42 rows of `ydocState bytea`) and a
`_prisma_migrations` row `20260706083131_init` from an abandoned experiment that persisted live
Yjs documents to Postgres — precisely what `tasks.md` §8 rules out. Those commits are dangling,
reachable from no branch, so nothing in the repo explained the tables. Both were dumped to a
backup and dropped, so `dead_rooms` now has a single migration history that replays cleanly
from an empty database. If a future `prisma migrate` reports drift, check for leftovers like
these before assuming the schema is wrong.

**Create the Neon branch *before* diverging the two databases, not after.** A branch is a
copy-on-write fork of the parent at the moment it is taken — and this bit during 7.2: `dev`
was cut from a snapshot of `main` that predated the cleanup, so it arrived carrying the same
42-row `Room` table and stale migration row, and had to be dropped and migrated a second time.
A branch does not track its parent.

**The two connection strings are not interchangeable, and swapping them fails confusingly
rather than loudly.** `DATABASE_URL` is Neon's *pooled* endpoint (its host contains `-pooler`)
and is what the app and the sync server use at runtime — Vercel runs many short-lived
instances that would each open their own pool and exhaust the project's connection ceiling
within a few requests. `DIRECT_URL` is the *unpooled* endpoint and is used by `prisma migrate`
alone: the pooler runs pgbouncer in transaction mode, which cannot hold the session-level
advisory lock a migration takes, so migrations pointed at the pooled URL hang or fail
part-applied.

### Prisma 7 invalidates almost every Prisma recipe written before it

Three breaking changes, all of which bite at a different moment:

- **The generator is `prisma-client`, not `prisma-client-js`** (deprecated), and `output` is
  now **required**. The client is therefore imported from that generated path
  (`../../generated/prisma/client`), **not** from `@prisma/client`. Importing the package path
  compiles fine and yields a client with no models on it.
- **A driver adapter is required.** Prisma 7 removed `datasourceUrl` *and* `datasources` from
  the `PrismaClient` constructor, so there is no way to hand it a URL directly; the connection
  string goes through `new PrismaPg({ connectionString })` from `@prisma/adapter-pg`. This is
  caught at compile time (`'datasourceUrl' does not exist in type 'PrismaClientOptions'`),
  which is the one merciful failure of the three.
- **Prisma no longer auto-loads `.env`,** and the datasource URL moved out of `schema.prisma`
  into `prisma.config.ts`. `prisma.config.ts` calls `dotenv`'s `config({ path: ".env.local" })`
  itself — Next's convention is `.env.local`, Prisma's default is `.env`, and loading the
  former explicitly keeps one file instead of two. Without that call the CLI reports a missing
  datasource URL rather than a missing file.

**`prisma init` writes more than Prisma files.** Run in a project root it also drops
`.claude/skills/`, `.windsurf/skills/`, `.agents/skills/` and a `skills-lock.json` alongside
the schema, and appends to `.gitignore`. Scaffold in a scratch directory and copy across, or
it silently edits this repo's agent configuration.

**`prisma generate` must run before `next build`, and `postinstall` alone is not enough on
Vercel.** Vercel restores a cached `node_modules` and can skip `postinstall` entirely, which
produces a build failing on a missing generated client that works perfectly locally. The
`build` script is therefore `prisma generate && next build`, with `postinstall` kept as a
convenience for fresh local installs. `next.config.ts` needs nothing: `@prisma/client` is
already on Next 16's built-in `serverExternalPackages` list.

### The sync server does not use Prisma

`server/db.js` is a plain `pg` pool and two hand-written INSERTs in one transaction. The sync
server writes one room's worth of rows in its entire life and never reads or updates one, so a
second `schema.prisma`, a `prisma generate` step, and the query engine in the Railway image
would all be overhead. This is the same deliberate duplication as `rateLimit.js` /
`rateLimit.ts`: **a column renamed in `schema.prisma` must be renamed in those statements by
hand — nothing checks it.** The only thing that catches a rename is running `saveDeadRoom()`
for real and reading both tables back, which is why that acceptance check exists.

**`server/roomState.js` is now the third instance of this cross-workspace duplication**, after
`rateLimit.js`/`rateLimit.ts` and `CLOSE_ROOM_NOT_FOUND`. It carries its own copies of
`sanitizeName` (from `app/lib/user.ts`) and `HEX_COLOR` (from `app/lib/awareness.ts`), because
`participants` is peer-supplied data that will be rendered on `/profile` and the server has no
way to import either. Keep the values in step by hand; the alternative — trusting awareness —
is a hole, not a simplification.

Two things there are load-bearing. `pool.on("error", …)` is mandatory, not defensive: an idle
connection dropped by Neon's pooler emits an `error` event on the pool, and unhandled that is
an uncaught exception which would kill the sync server — taking every live room with it —
because of a database it was not even using. And `DATABASE_URL` is **optional**: unset, no pool
is opened and `saveDeadRoom()` is a logged no-op, so the guest flow (which stores nothing and
is the whole of v1) never depends on database infrastructure it does not touch.

`ON CONFLICT (room_id) DO NOTHING` is what enforces `tasks.md` §6's write-once rule against a
retry or a restart that re-evicts an already-saved room, and it only works because `room_id`
carries a `UNIQUE` constraint.

**The `id` column has no database default, and `server/db.js` is the only reason that works.**
`@default(uuid())` in `schema.prisma` is a *Prisma-side* default: the generated
`migration.sql` says plainly `"id" UUID NOT NULL` with no `DEFAULT` clause, because Prisma
mints the UUID in its client. The sync server has no Prisma client, so its INSERT supplies
`gen_random_uuid()` itself. Drop that from the statement and every write fails on a null
`id` — and the schema will look innocent, since it does declare a default. Use
`@default(dbgenerated("gen_random_uuid()"))` instead if a database-level default is ever
wanted.

**Verify this pairing by running the INSERT, not by reading the DDL.** A `\d dead_rooms`
proves the table parses; it proves nothing about whether the hand-written statement still
matches it. The check that catches a rename is calling `saveDeadRoom()` for real and reading
the row back.

**Write `sslmode=verify-full` in the connection strings, not the `sslmode=require` Neon hands
you.** node-postgres currently treats `require`, `prefer` and `verify-ca` as aliases for
`verify-full`, and warns on every connection that pg v9 will switch them to libpq semantics —
under which `require` encrypts but **does not verify the certificate at all**. So the string
that looks safe today becomes a silent downgrade to an unauthenticated TLS session on a routine
`npm update`. `verify-full` pins the strong behaviour and removes the warning; verified working
against Neon. `server/db.js` additionally passes `ssl: { rejectUnauthorized: true }`
explicitly, which survives that change regardless — the connection string is the part that
would rot. Neon also appends `&channel_binding=require`, which node-postgres ignores; it is
dropped from these strings rather than carried along as decoration.

**`verify-full` is the right string for the app and the wrong one for `psql`.** node-postgres
verifies against Node's bundled CA store, so the URL in `.env.local` needs nothing more. The
`psql` CLI instead looks for `~/.postgresql/root.crt` and refuses to connect at all
(`root certificate file … does not exist`) — for ad-hoc queries append
`&sslrootcert=system`. **Never put `sslrootcert=system` in an env file**: node-postgres reads
that value as a *filename* and will try to open a file called `system`.

### Two deliberate departures from `tasks.md` §6

- **`room_id` is `UNIQUE`.** This makes the database enforce "written once, never updated"
  instead of trusting the writer, and it is what `ON CONFLICT (room_id) DO NOTHING` rests on.
  7.2 also shipped an index on `(owner_user_id, died_at DESC)` for the `/profile` query;
  **7.3's migration dropped both that index and the column**, because §6.1 replaced
  creator-owns with `dead_room_members`. That table's composite primary key
  `(user_id, dead_room_id)` — `user_id` leading, so one user's rows are contiguous — is now the
  index the profile listing uses, and the listing is a join.
- **`language` is nullable**, where §6 writes plain `text`. This is forced, not stylistic: the
  language dropdown is a per-user editing preference kept deliberately off the shared `Y.Doc`
  (see "Saving"), so **the server has no language to record** until §10.1 moves the selector to
  room creation. It is written as `null` today, and the snapshot's single file is named
  `main.txt` for the same reason — there is no room-wide language from which to derive an
  extension.

## Environment variables

| Var | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_WS_URL` | `collab-code-editor/.env.local` | WebSocket server URL. Defaults to `ws://localhost:8080`; production points at the Railway `wss://` URL. **Also the source of the room-routes HTTP base** — `app/lib/rooms.ts` swaps the scheme, so there is no separate variable to keep in sync. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `collab-code-editor/.env.local` | Clerk API keys. `next build` still succeeds without them (`proxy.ts` doesn't run at build time) and `next dev` still boots, because `@clerk/nextjs` falls back to *keyless mode* and provisions a throwaway instance under `.clerk/` (gitignored, holds that instance's secret key). **An earlier version of this table claimed a production start 500s the whole site without them. That is false** — measured on `@clerk/nextjs` 7.6.2 by running `NODE_ENV=production next start` with both keys removed *and* `.clerk/` deleted, so keyless could not mask it: `/` served 200 and `/robots.txt` 404, exactly as with keys. Missing keys degrade auth; they do not take the site down. Do not use this as the explanation for a 5xx. |
| `PISTON_API_URL` | `collab-code-editor` | Piston base URL. Defaults to `http://localhost:2000`. **No trailing slash** — `app/api/execute/route.ts` appends `/api/v2/execute`. On Vercel it holds the tunnel hostname (see "Production execution path"); Vercel env changes only reach a *new* deployment, so changing it requires a redeploy. |
| `PISTON_OUTPUT_MAX_SIZE`, `PISTON_RUN_TIMEOUT`, `PISTON_RUN_CPU_TIME`, `PISTON_COMPILE_TIMEOUT`, `PISTON_COMPILE_CPU_TIME`, `PISTON_RUN_MEMORY_LIMIT`, `PISTON_COMPILE_MEMORY_LIMIT` | `collab-code-editor/docker-compose.yml` | Ceilings inside the Piston container, **not** app config — they exist only in compose, and Piston rejects any per-request limit above them. Keep in step with the constants in `app/api/execute/route.ts`. |
| `PORT` | `server/.env` | Port for both the WebSocket upgrade and the room HTTP routes. Defaults to `8080`. |
| `ROOM_GRACE_MS` | `server/.env` | How long an emptied room lingers before destruction. Defaults to `10000`. |
| `ROOM_RESERVATION_MS` | `server/.env` | How long a created-but-never-entered room stays claimable. Defaults to `300000`. |
| `DATABASE_URL` | `collab-code-editor/.env.local` **and** `server/.env` | Neon's **pooled** connection string (host contains `-pooler`). Used at runtime by `app/lib/db.ts` and `server/db.js`. **Optional in `server/`** — unset, `db.js` opens no pool and `saveDeadRoom()` is a no-op, so the sync server boots and serves rooms exactly as in v1. |
| `DIRECT_URL` | `collab-code-editor/.env.local` only | Neon's **unpooled** string, used by `prisma migrate` alone. Not interchangeable with `DATABASE_URL` — see "Persistence (Postgres)". The sync server has no counterpart because it never migrates. |
| `CLERK_SECRET_KEY` | `collab-code-editor/.env.local` **and** `server/.env` | In the app, Clerk's usual server key. In `server/`, used *only* by `verifyToken` on the WebSocket. **Optional in `server/`** — unset, no token is verified, no room has members and nothing is written, so the guest flow never depends on auth infrastructure. Must be the **same Clerk instance** as the frontend's publishable key: a mismatched key fails every token with no visible symptom at all (rooms work; snapshots simply never appear), which is why `clerkAuth.js` warns once per process. |
| `MEMBER_MIN_CONNECTED_MS` | `server/.env` | How long a signed-in participant must be connected before they can earn a `dead_room_members` row. Defaults to `60000`. Only half the threshold — see "Who a dead room belongs to". |
| `SNAPSHOT_FLUSH_MS` | `server/.env` | Ceiling on how long a shutdown waits for snapshot writes. Defaults to `20000`. A ceiling, not a delay — but since 7.5 it bounds a *drain*, not one batch: N queued rooms take `ceil(N / POOL_MAX) × per-write`, measured ~6.6s for 40 rooms against a warm Neon. An empty queue still shuts down in about half a second. |
| `SNAPSHOT_WRITE_LIMIT`, `SNAPSHOT_WRITE_WINDOW_MS` | `server/.env` | The snapshot write pacing, keyed on the room creator's IP. Default `60` per `60000`ms — deliberately *not* `POST /rooms`' 10; see "The snapshot write queue". Over-limit writes wait rather than being dropped. Lower both to exercise the deferral path in seconds. |
| `DB_CONNECT_TIMEOUT_MS` | `server/.env` | Per-attempt Postgres connect timeout. Defaults to `10000`. Must stay **under** `SNAPSHOT_FLUSH_MS` and **over** a Neon cold start — see "Dead-room snapshots". |

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

**Section 7 is complete: 7.1 (Clerk auth), 7.2 (Postgres), 7.3 (the dead-room snapshot),
7.4 (`/profile`) and 7.5 (guardrails) are all done** — see "Accounts (Clerk)", "Persistence
(Postgres)", "Dead-room snapshots", "The profile page" and "The snapshot write queue" above,
which replace older notes here claiming none of them existed. **What remains unticked:** all of
section 10, which now has eight subsections rather than three — the original 10.1 multi-file,
10.2 chat and 10.3 room passwords, plus 10.4 stdin for runs, 10.5 keyboard shortcuts,
10.6 room names, 10.7 deleting a snapshot from `/profile` and 10.8 the last-person-leaving
warning. None are built. Section 10 ends with a suggested order for them, which is by payoff
rather than dependency. Redis pub/sub for horizontal scaling is
*not* a v2 item at all — section 8 puts it explicitly out of scope, so it stays deferred past
v2.

The whole v2 loop now closes: `server/rooms.js`'s `destroyRoom()` writes the snapshot and
`/profile` reads it back, so a signed-in user's work really does outlive the tab. An older note
here said "nothing reads it yet — do not add UI pointing at one"; that is no longer true.

**A UI/UX redesign also shipped, outside the checklist** — it is recorded as `tasks.md` §7.7
and described under "Design system and theming" and "The resizable room layout" above. It
changed no behaviour in sync, presence, execution, auth or persistence, but it touched nearly
every component, so notes written before it may describe markup that no longer exists.
Three concrete things it invalidated across this file, all corrected in place: `/room/[roomId]`
no longer 500s, the app is no longer dark-only, and `EditorToolbar.tsx`/`UserBar.tsx` are gone
(now `RoomChrome.tsx` + `PresenceStack.tsx`).

**7.5 is done, and two of its three bullets were ticked on verification rather than on new
code.** An older note here said "do not tick it on that basis" — that instruction was followed:
a dead room's `room_id` can never be reused and `/room/<old-dead-id>` sends you home have both
been true since v1 (see "Room lifetime"), so instead of building a second, weaker copy of a gate
that already works, a room was driven through its real lifecycle to death and the behaviour was
observed — `{"exists": false}`, a raw socket closed with 4404, the ID still dead after the
probe, and a browser watched being sent home. The third bullet, rate-limiting DB writes, is
built: `server/snapshotQueue.js`, described under "The snapshot write queue".

**7.4's read path is still unlimited, and that remains a deliberate gap.** Every `/profile` view
is one uncached Neon query. It is bounded by Clerk authentication and by a single indexed lookup
per request, which is why 7.5 did not cover it — but nothing stops a signed-in user from
refreshing in a loop, so if the read path ever grows a second query or an unindexed one, revisit
this.

The two facts 7.4 was warned about both held, and are now documented under "The profile page":
the listing is a join from `dead_room_members`, not a column filter; and `language` being null
with every file called `main.txt` is a permanent state until §10.1, not a backfill.

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
