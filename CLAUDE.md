# Real-Time Collaborative Code Editor

A multiplayer code editor: Yjs CRDT sync over WebSockets, plus sandboxed multi-language
execution via a self-hosted Piston instance.

## Where the rationale lives

**This file is the core: the repo map, the cross-cutting invariants, the traps that bite on any
task, and the environment.** The per-subsystem *why* — measurements, rejected alternatives, the
"this cost a session to find" stories — was split out on 2026-07-31 into `docs/internals/`, because
carrying all of it in every session cost ~38k tokens before a word was typed.

| File | What it owns |
| --- | --- |
| `docs/internals/room-lifetime-and-files.md` | The reserved→live→grace→destroyed lifecycle, the server-side room gate, and the multi-file shape (the `files` map, the fixed `"main"` entry id, one `Y.Text` per file, one Monaco model and binding per file) |
| `docs/internals/execution.md` | The Run button and the shared `execution` map, the ceilings a run may consume, and why Piston is local-only |
| `docs/internals/clerk-auth.md` | Optional sign-in, `?token=` on the socket, and every way the Clerk pairing fails silently |
| `docs/internals/snapshots-and-postgres.md` | What is written when a room dies and for whom, plus the database that receives it (Neon, Prisma 7, the sync server's hand-written INSERT) |
| `docs/internals/profile.md` | `/profile`, the only reader of `dead_rooms`, and the in-room chip that estimates whether your work reaches it |
| `docs/internals/ui.md` | Theming, the resizable split, load-bearing accessibility, Save, and the keyboard shortcuts |
| `docs/internals/limits.md` | The three limiters: `POST /rooms`, `/api/execute`, and the snapshot write queue |

**Read the relevant one before touching that subsystem.** Every rule those files state is
load-bearing and was paid for in debugging; none of it is background reading.

**Cross-references between sections are by name, not by number** — a phrase like *see "Room
lifetime"* survived the split, but "above" and "below" may now mean another file. Resolve one with
`grep -rn '"Room lifetime"' CLAUDE.md docs/internals/`.

### Every completed change updates the docs in the same change

Before reporting any work done, do all of these — not in a follow-up commit:

1. **Update this file or the right `docs/internals/` file.** A new key file goes in the *Repo
   layout* table here; a new env var in the *Environment variables* table here; a new invariant or
   gotcha goes wherever that subsystem lives. The value is the gotchas, not the feature list — if a
   limit, ordering, or lifecycle detail was non-obvious enough to cost a debugging session, write
   it down.
2. **Update `README.md` if the change is user-visible.** A new feature belongs in its *Features*
   table; a shipped feature moves *off* the *Future improvements* list. The README is for
   developers, recruiters and beginners — keep internal detail out of it, but never let it describe
   something that no longer exists.
3. **When a change makes a paragraph false, rewrite that paragraph** rather than appending a
   correction beside it. (`docs/learning.md` retells this history for teaching and is the one file
   allowed to; it derives from these notes and is never the source.)

## Scope of work: there is no checklist any more

**`docs/tasks.md` was deleted on 2026-07-30, and with it the last checklist in the repo.** v1's
`V1_Tasks.md` had already gone the same way once every box was ticked (commit `dfbaf1b`). Older
paragraphs cite them by section number — `§6.1`, `§7.5`, `§10.1` — and those citations are kept
deliberately: they are the historical names of decisions these files now explain in full, and they
still resolve in git history. **Do not chase them; nothing outstanding lives there.**

- **This file plus `docs/internals/` is the authority on what exists and why.** Every section
  describes shipped behaviour. If a feature is not described, it is not built.
- **`README.md` is the authority on what is *not* built.** Its *Future improvements* list is the
  only forward-looking record. Nothing is "next" by default — the user names the work.
- **`docs/TESTING.md` is the authority on what is proven**, and §12 there is the honest list of
  what was deliberately not covered.

**Out of scope, and not to be added even as a convenience:**

- **Postgres is the only data store — no Redis, no cache, no session store.** This is why the
  frontend's rate limiter is per-instance and says so, rather than being "fixed" with a round trip.
- A dead room is never re-run, re-joined, or edited in place.
- No horizontal scaling across multiple sync-server instances. Room lifetime is owned by exactly
  one module in exactly one process, and that assumption is load-bearing throughout.

## What v2 added, in one paragraph

v1's defining constraint was **zero persistence** — a room and everything in it vanished when
the last person left. v2 keeps that for the live room and relaxes it in exactly one place:
**Clerk** adds real accounts alongside the unchanged guest flow, and when a room dies its final
files are written **once** to a `dead_rooms` table in **PostgreSQL** — but only if at least one
participant was signed in, stayed, and edited. Fully-guest rooms still save nothing at all. The
snapshot is read-only forever: a `/profile` page lists a signed-in user's past rooms and lets them
view, copy, download and delete the code, never run or rejoin it. Sync, awareness, room lifetime,
and Piston execution are all **unchanged** from v1. Riding along with it: **multi-file rooms with
the language chosen once at creation and a starred entry file**, stdin, keyboard shortcuts,
snapshot deletion, the leaving warning, a full UI/UX redesign with light and dark themes, a
repository reorganization, and an audit that added the test suite and CI. **Still unbuilt:** an
ephemeral in-room chat over the existing WebSocket, optional room passwords held only in the
in-memory room object, and room names.

## Repo layout

Two independent workspaces, plus the sandbox container and the docs at the root. **There is no
root `package.json`** — install and run each workspace separately.

| Path | What it is |
| --- | --- |
| `web/` | Next.js 16 (App Router) frontend. Monaco editor, room routing, and the `/api/execute` proxy to Piston. |
| `server/` | Standalone Node.js WebSocket server speaking the Yjs sync protocol, plus the room-lifetime HTTP routes on the same port. Carries a `railway.json`; Railway is its deployment target when one is wanted. |
| `docker-compose.yml` | The Piston sandbox. At the **repo root**, not inside `web/` — it is a third service, not part of the frontend. |
| `docs/` | `TESTING.md` (the audit report), `DEPLOYMENT.md` (the hosting runbook) and `learning.md` (the teaching document). `tasks.md` was deleted; `README.md`, `LICENSE` and this file stay at the root by convention. |
| `web/tests/` | vitest: the unit tier, the `drift/` tier, `fixtures/hostile.ts`, and `setup/no-ambient-secrets.ts`. |
| `web/e2e/` | Playwright. The only cross-service tier; `helpers.ts` holds every selector trap. |
| `server/tests/` | vitest: `unit/` (hermetic) and `integration/` (spawns the real server, raw `ws`). |
| `.github/workflows/` | CI. Two jobs, one per workspace, plus a job that states what CI cannot cover. |

### The five structural rules

These are conventions, not preferences — each one closes a specific failure the flat layout had.

1. **`web/src/app/` holds routes and nothing else.** Every `page`/`layout`/`route`/`error` file
   lives there; everything importable lives beside it in `components/`, `hooks/`, `lib/` or
   `styles/`. Putting a shared module back under `app/` makes it indistinguishable from a route.
2. **Cross-folder imports use the `@/` alias; same-folder imports stay relative.**
   `@/lib/collab/user` from anywhere, `./FileTabMenu` between siblings. `@/*` maps to `./src/*`
   in `web/tsconfig.json`. Before this, all 158 internal imports were relative and 14 climbed two
   levels, so any move was a rename storm — which is exactly what the alias exists to prevent.
   **One deliberate exception:** `lib/data/db.ts` imports the generated Prisma client with
   `../../../generated/prisma/client`, because `generated/` sits *outside* `src/` and so has no
   alias. Do not "fix" it into `@/`.
3. **In both workspaces the folder carries the domain and the file carries the role.** Hence
   `server/src/rooms/lifecycle.js` rather than `rooms/rooms.js`, and `lib/sandbox/` rather than
   `lib/execution/execution.ts`. `lib/ui.ts`, `theme.ts`, `platform.ts` and `sound.ts` stay at the
   `lib/` root because a one-file folder would only add a stutter.
4. **`web/src/proxy.ts` is inside `src/`, and must stay level with `app/`.** Next resolves the
   proxy convention at the project root *or* inside `src/` — never `src/app/`. The check that it
   is still wired is `ƒ Proxy (Middleware)` in `next build` output; a misplaced file fails silently.
5. **Tests live inside the workspace they test, and `web/e2e/` is the only cross-service tier.**
   `web/tests/`, `server/tests/`, `web/e2e/`. There is no third top-level test directory and no root
   `package.json`, so the gate is two commands and CI is a two-job matrix — rule 5 exists to keep
   rule 0 ("there is no root `package.json`") true. The corollary is that anything shared between the
   two workspaces' tests is **duplicated on purpose**, exactly like the source it tests:
   `web/tests/fixtures/hostile.ts` and `server/tests/fixtures/hostile.mjs` are the eighth and ninth
   entries on the hand-maintained-duplication list, and `web/tests/unit/drift/` is what stops the
   whole list rotting silently.

### Comments: this file carries the rationale, the code carries the rule

The code was deliberately reduced from ~3,100 comment lines to ~650. **Do not reintroduce
explanatory essays in source files.** The division is:

- **In the code:** at most 1–2 lines, and only where the logic is genuinely non-obvious. A rule a
  future edit could break silently gets exactly one line, prefixed `// INVARIANT:` — ordering
  constraints, trust boundaries, coupled numeric ceilings, "never throws" contracts, and a
  `// keep in sync with <path>` marker on each of the seven hand-maintained cross-workspace
  duplications. There are ~175 such lines and they are load-bearing: **do not delete an
  `INVARIANT:` line to tidy up.**
- **In this file:** the why. The measurements, the rejected alternatives, the debugging history,
  the "this cost a session to find" stories. That is what the sections below are *for*, and it is
  why compressing the code lost nothing — every essay removed from a source file is already
  written up here at greater length.

So when a gotcha turns up, add it here and leave a one-line pointer there. The reverse — a
paragraph in the source and nothing here — is the shape this codebase moved away from.

**One deliberate exception to the 1–2 line rule:** `saveDeadRoom`'s JSDoc in
`server/src/storage/db.js` keeps its full `@param` object shape and `@returns` union. `server/` is
plain JavaScript with no TypeScript, so that block is the *only* declaration of the snapshot
contract between `rooms/state.js` and this INSERT — it is a type signature, not prose. Deleting it
is closer to deleting code than to tidying a comment.

One mechanical trap found while doing it: **`server/src/rooms/state.js` contains regex literals
with `\u0000` and `\uD800`–`\uDFFF` escapes.** Tool-call arguments JSON-decode `\uXXXX`, so
rewriting those lines through an editing tool can silently write *real* NUL and lone-surrogate
bytes and turn the file binary. Edit around them.

**An earlier version of this paragraph prescribed `grep -P '\x00'` as the check. That check has
never worked** — grep classifies the file as binary and reports nothing unless you pass `-a`. The
audit hit this the hard way: writing `\u0000` into two new files produced real NUL bytes, git
flagged them as binary, and the documented guard stayed silent. Two things replaced it:

- `file server/src/rooms/state.js` must still say "UTF-8 text" — that one *does* work, because
  `file` reports "data" for a NUL-bearing file.
- `GUARD-01` in `web/tests/unit/guards/source-encoding.test.ts` scans the whole tree at the byte
  level on every test run, which is the real guard. It caught itself on its first execution.

Also worth knowing, because it explains why some files survive and others do not: **`\u0000` gets
JSON-decoded into a real byte, but `\uD800` does not** — JSON cannot encode a lone surrogate, so it
passes through as literal text. That is why `executionState.ts`'s `/[\uD800-\uDBFF]$/` was fine
while a `\u0000` two lines away was not. New test fixtures build every dangerous character with
`String.fromCharCode` for exactly this reason.

Key files:
- `web/src/proxy.ts` — Clerk's request hook. **Next 16 renamed `middleware.ts` to `proxy.ts`**; it attaches the session and protects nothing
- `web/src/lib/collab/clerkIdentity.ts` — the one boundary between Clerk and the app; nothing else imports `useUser` or `useAuth`. Also exports `useClerkToken()`, the sanctioned way an account ID reaches the sync server
- `web/src/lib/editor/monacoLoader.ts` — points `@monaco-editor/react` at the npm package so no global AMD loader is installed
- `web/src/components/editor/CodeEditor.tsx` — the room screen. **Composition only**: it holds `language`, `code` and the Monaco instance, and hands everything else to the hooks and panels below
- `web/src/hooks/useCollabRoom.ts` — the whole client-side Yjs stack (doc, provider, awareness, one Monaco model + binding per file, the shared `execution` map and the stale-run watchdog), plus the peers/files/toasts it mirrors into React and the four file actions
- `web/src/lib/collab/roomFiles.ts` — the only description of a multi-file room's shared shape: the map/text names, the fixed `"main"` entry id, `MAX_FILES`, and `readRoomFiles()`, the boundary that makes a peer-supplied filename safe to render, download and store
- `web/src/hooks/useCodeRunner.ts` — the Run button: reads the **entry file** out of the doc at click time, then the POST to `/api/execute` and the shared-map write, including the `runId` staleness check
- `web/src/hooks/useEditorShortcuts.ts` — Ctrl/Cmd+Enter and Ctrl/Cmd+S, bound to the Monaco instance and never to `window`
- `web/src/hooks/useRoomPersistence.ts` — the sole-peer `beforeunload` and the client-side estimate of whether this room reaches your profile
- `web/src/lib/data/persistence.ts` — the estimate's constant, states and wording, and the long note on why it can only ever be an estimate
- `web/src/lib/platform.ts` — ⌘ vs Ctrl, for tooltips only; changes no behaviour
- `web/src/components/editor/PersistenceChip.tsx` — that estimate as one chip in the room's chrome, and where the leaving warning's actual sentence lives
- `web/src/components/ui/ConfirmDialog.tsx` — the generic destructive-confirmation modal; `IdentityDialog`'s scrim/trap treatment, generalised
- `web/src/components/profile/DeleteSnapshotButton.tsx` — the only caller of the delete action, and `/profile`'s second client component
- `web/src/app/profile/actions.ts` — the repo's only `"use server"` module: auth, delete, revalidate, redirect
- `web/src/hooks/useCopyToClipboard.ts` — copy + the transient "copied" flag, with the non-secure-context fallback
- `web/src/lib/sandbox/executionState.ts` — the `ExecutionState` union, the map/key names, `STALE_RUN_MS`, and `isFailedRun()`; imported by the hooks *and* the output panel
- `web/src/lib/collab/cursorStyles.ts` — the remote-cursor `<style>` block; the only thing that writes a peer colour into CSS
- `web/src/lib/editor/download.ts` — Save, in full: a Blob and a throwaway `<a download>`, nothing else. Shared with `/profile`'s Download button since 7.4, and since §10.1 also `downloadZipFile`, which loads JSZip behind a dynamic import
- `web/src/components/editor/RoomChrome.tsx` — the room's single chrome bar (room id + sync dot, presence, theme, Save, Run). Replaced `EditorToolbar.tsx` and `UserBar.tsx`, which were two full-width rows
- `web/src/components/editor/EditorPane.tsx` — Monaco, and only Monaco. `memo`'d, and the file that documents why it must never be keyed, conditionally rendered, or moved between parents — and why its `path` prop is the one sanctioned way to change file
- `web/src/components/editor/EditorTabBar.tsx` / `FileTabMenu.tsx` — the file tabs (entry star, `+`, inline rename) and the right-click/kebab menu behind them. Presentational: every file they render has already been through `readRoomFiles`
- `web/src/components/editor/OutputPanel.tsx` / `PanelStrip.tsx` / `icons.tsx` — the rest of the chrome around Monaco; presentational, no Yjs. `PanelStrip` is the shared tab strip and exports `PANEL_STRIP_HEIGHT`
- `web/src/components/editor/ResizeHandle.tsx` — the drag divider; wraps `react-resizable-panels`' `Separator`
- `web/src/hooks/useRoomLayout.ts` — split orientation, persisted sizes, output-collapsed state, and the narrow-screen override
- `web/src/components/editor/JoinRoomPrompt.tsx` — the room's name prompt, and the only room-side reader of Clerk
- `web/src/app/room/[roomId]/page.tsx` — dynamic room route; `roomId` is the Yjs document name
- `web/src/components/editor/RoomGate.tsx` — decides whether a room may be entered at all, *before* the editor (and therefore the socket) exists
- `web/src/lib/collab/rooms.ts` — the client's view of room lifetime: `WS_URL`, the derived HTTP base, `createRoom(language)`, `checkRoom()` (which since §10.1 also returns the room's language)
- `web/src/lib/collab/user.ts` — the entire user model: palette, name sanitizing, and identity as an external store
- `web/src/lib/collab/awareness.ts` — `readPeers()`, the one boundary that turns hostile remote awareness state into values the UI may render
- `web/src/lib/editor/languages.ts` — the one supported-language enumeration: labels, file extensions, the Save filename, per-language starter code, and the new-file name suggestion; shared by the landing page's room-creation select, the editor and the execute route
- `web/src/components/editor/PresenceStack.tsx` — presence as an overlapping avatar stack; renders only what `readPeers` returned
- `web/src/components/ui/IdentityDialog.tsx` — the name/colour prompt, shared by the create and join flows
- `web/src/styles/globals.css` — the whole design system: the light and dark token values, and the `@theme inline` block that turns them into Tailwind utilities
- `web/src/lib/ui.ts` — the shared button/card/input class strings. The one place a button style is written; safe to import from both server and client components
- `web/src/lib/theme.ts` — the `Theme` union, the storage key, and `THEME_SCRIPT`, the no-flash inline script
- `web/src/lib/editor/monacoThemes.ts` — `collab-light` / `collab-dark`, whose backgrounds match `--code-bg`
- `web/src/components/layout/ThemeProvider.tsx` / `ThemeToggle.tsx` — theme as an external store, and the three-way Light/System/Dark control
- `web/src/components/layout/AppProviders.tsx` — `ThemeProvider` wrapping `ClerkProvider`, so Clerk's `appearance` can follow the theme
- `web/src/components/layout/SiteNav.tsx` — the top bar for every screen that is not the room
- `web/src/app/not-found.tsx` / `error.tsx` / `global-error.tsx` — the root 404, the root error boundary, and the layout-failed page that renders its own `<html>`
- `web/src/app/icon.svg` — the favicon, via Next's file convention
- `web/src/lib/sandbox/execution.ts` — the cap on what may be *sent* for execution (`MAX_CODE_BYTES`) and `payloadTooLarge()`, the one budget rule covering code **and** stdin together; shared by the client's pre-flight check and the route's 413
- `web/src/lib/sandbox/rateLimit.ts` / `server/src/http/rateLimit.js` — the same in-memory sliding-window limiter, once per workspace
- `web/src/app/api/execute/route.ts` — server-side proxy to Piston; also where the sandbox-side execution limits live
- `server/src/sync/connection.js` — the only place that speaks the Yjs wire protocol; also the gate that refuses connections to rooms that don't exist, and where a `?token=` becomes a member session
- `server/src/rooms/lifecycle.js` — the one authority on whether a room exists, and the only thing that ever deletes one. `destroyRoom()` is the single destroy site and therefore the one place a snapshot is *taken* — since 7.5 it hands that snapshot to `snapshotQueue.js` rather than writing it
- `server/src/storage/snapshotQueue.js` — the one place that decides *when* a snapshot is written: the concurrency cap, the per-creator-IP pacing, and the shutdown drain. Nothing else may call `db.saveDeadRoom()`
- `server/src/rooms/state.js` — what a room *was*, as opposed to whether it exists: `created_at`, the room's language, the verified-member set with its connected-time and did-edit accounting, the accumulated participant list, and `buildSnapshot()` (which since §10.1 walks the whole file map inside one shared byte budget)
- `server/src/auth/clerk.js` — the one place a Clerk token becomes a user ID. Never refuses a socket
- `web/prisma/schema.prisma` — the authority on the `dead_rooms` table's shape, and the only place it is described declaratively
- `web/prisma/migrations/` — the applied SQL history, committed. Two migrations: `20260729084725_init_dead_rooms` and `20260729122125_dead_room_members` (which drops `owner_user_id` and its index), replaying from an empty database
- `web/prisma.config.ts` — Prisma **CLI** config (migrate/generate/studio). Loads `.env.local` by hand and points migrations at `DIRECT_URL`
- `web/src/lib/data/db.ts` — the one place the app learns about Postgres; server-only, never imported from a `"use client"` module
- `web/src/lib/data/deadRooms.ts` — the one place the app *reads* `dead_rooms`, and the boundary that turns its `jsonb` columns into renderable values. Also server-only, and the module that enforces "a snapshot is fetched through its membership row or not at all"
- `web/src/app/profile/page.tsx` / `[deadRoomId]/page.tsx` — the listing and one read-only snapshot; both async Server Components that gate on `await auth()`
- `web/src/app/profile/error.tsx` / `[deadRoomId]/not-found.tsx` — "the database is unreachable" and "that snapshot isn't yours", kept distinct from each other and from an empty profile
- `web/src/components/layout/ProfileShell.tsx` — the profile chrome: page frame, the shared panel, and the signed-out gate. Carries no database import, because `error.tsx` is a Client Component and imports from it
- `web/src/components/profile/SnapshotFile.tsx` / `SnapshotActions.tsx` / `SnapshotDownloadAll.tsx` / `DeadRoomCard.tsx` — the `<pre>` code view, its Copy/Download buttons, the multi-file `project.zip` button (these three are the only client-side code on `/profile`), and one listing row
- `server/src/storage/db.js` — the sync server's whole database surface: one `pg` pool and one INSERT, no ORM

## Testing

Full procedure and results: **`docs/TESTING.md`**. The division of labour is the same one this file
already draws for comments — **`CLAUDE.md` keeps the rationale and the traps, `docs/TESTING.md` keeps
the procedure and the numbers.** Do not duplicate one into the other.

Four tiers. The first three are hermetic: no Postgres, no Clerk, no network.

```bash
cd web    && npm run lint && npm run typecheck && npm test   # unit + dom + drift
cd server && npm run lint && npm run test:unit && npm run test:integration
cd web    && npm run test:e2e                                # needs all three services
```

**Every test title begins with its case ID**, so a claim anywhere is traceable to its proof:
`grep -rn "SEC-05d" web/tests server/tests web/e2e`.

Traps that are *new* with the suite (the pre-existing ones — `dialog.accept()`, `localhost` not
`127.0.0.1`, the non-breaking spaces, `#room-language` — already have their own sections above and
are not repeated here):

- **Start the sync server with `ROOM_CREATE_LIMIT=300` for the e2e tier.** It creates ~20 rooms in
  two minutes and otherwise trips the 10/min default, surfacing as a room-creation timeout inside an
  unrelated spec.
- **A visible Monaco is not a ready room.** The starter file lands only after the provider fires
  `sync`; before that `entryFile` is null and `useCodeRunner` returns early *without writing
  anything*, so a Run click is silently swallowed and the output pane still reads "Output will appear
  here…". Use `waitForRoomReady()`. Measured 10/10 rooms seed correctly, so this is a test-timing
  trap, not a seeding bug.
- **Never read room text from `document.body.innerText`** — Monaco keeps a hidden accessibility
  mirror, so it shows the document twice. That looks exactly like a double-seed bug and is not.
- **Focus Monaco by clicking `.view-lines`, never its hidden `textarea`.** Clicking the textarea
  appears to work — select-all even takes effect — but the keystrokes never reach the model.
- **`server/src/rooms/state.js` and `snapshotQueue.js` read `process.env` at module load**, so any
  test varying a knob must bust `require.cache` and re-require. Hence `pool: "forks"`.
- **`bindRoomObservers` reads `doc.awareness`**, which y-websocket attaches in production. A bare
  `Y.Doc` in a test makes every observer throw.
- **`retries: 0` in Playwright is deliberate.** A retry that goes green hides the CRDT and presence
  races the suite exists to catch. Two flakes surfaced this way and both were real bugs.
- **`npm run typecheck` is `next typegen && tsc --noEmit`, and the `next typegen` half is
  load-bearing.** `PageProps<"/room/[roomId]">` — used by both dynamic routes — is a *global* Next
  16 generates into `.next/types/routes.d.ts`, alongside `next-env.d.ts`. Both are gitignored and
  both are written only by `next dev`, `next build` or `next typegen`. So a bare `tsc --noEmit`
  passes on any machine that has ever run the dev server and fails on a fresh checkout with
  `TS2304: Cannot find name 'PageProps'` — which is exactly what CI is, and exactly how this was
  found: green locally, red on GitHub. Reproduce the CI state with
  `rm -rf web/.next web/next-env.d.ts` before trusting a local typecheck.

## Running locally

Three processes:

```bash
# 1. Piston sandbox (code execution) — from the REPO ROOT, not web/
docker compose up -d

# 2. Yjs WebSocket server -> :8080
cd server && npm install && cp .env.example .env && npm run dev

# 3. Frontend -> :3000
cd web && npm install && npm run dev
```

## Failing safe: the sync server must not die

**A crash is not SIGTERM.** That single sentence is why this section exists. `flushAndDestroyAll()`
runs on SIGTERM and nowhere else, so an uncaught fault took every live room's unsaved snapshot with
the process — and the restart came up with an empty registry, so nothing could ever retry the write.
One anonymous request could therefore destroy everyone's work in every room. The audit found **three**
ways to do it, all unauthenticated:

1. **`GET /rooms/%`** — `decodeURIComponent` throws `URIError` on `%`, `%zz`, and on any escape that
   decodes to a lone surrogate (`%ED%A0%80`). Now `safeDecode()` returns null. **The route still
   answers 200 with `exists:false`, never 400**: `checkRoom()` reads any non-ok response as
   *unreachable*, which would show the retry screen for a room that never existed.
2. **A malformed `Host` header** (`Host: a b`) or an absolute-form request target (`GET http://[`) —
   `new URL(req.url, "http://" + host)` throws `TypeError`. The origin was never used, only the path
   and the query, so `requestTarget()` splits the target by hand and uses `URLSearchParams`, which
   never throws on any input.
3. **Any malformed WebSocket frame.** `y-websocket`'s `setupWSConnection` registers
   `conn.on('message')`, `'close'` and `'pong'` — and **no `'error'`**. `ws` emits `'error'` on the
   WebSocket for every protocol fault, and an `'error'` event with no listener *throws*. Reachable
   before the room gate, so no room id was even needed.

**The ordering in point 3 is the part to remember.** `ws` defaults `maxPayload` to 100 MiB, and
capping it is the obvious hardening — but a frame over the cap raises *the same* unhandled `'error'`.
Setting `maxPayload` without first registering `ws.on("error")` converts a memory-pressure problem
into a **one-frame remote kill switch**. They must land together, and `connection.js` registers the
listener before any early return so it also covers sockets that are about to be refused.

On top of those three: the request listener is wrapped in `try/catch`, and
`uncaughtException`/`unhandledRejection` handlers drain snapshots before exiting non-zero — so the
*next* unknown fault is survivable rather than silently lossy. `process.exitCode` rather than
`process.exit()`, because `exit()` truncates pending stdout on Railway.

## Gotchas

**`docker-compose.yml` pins `name: collab-code-editor`, and that line is load-bearing.** Compose
derives its project name from the containing directory, which names the volume
(`<project>_piston_data`) and labels the container. Renaming the app directory from
`collab-code-editor/` to `web/` — and moving the compose file to the root — would therefore have
pointed at a *new* project: a fresh empty `piston_data`, with every installed language package
re-downloaded, and a name collision against the still-running `piston_api`. Pinning the old
project name keeps both. It reads as a stale name; it is the opposite. Verified with
`docker --context default compose ps` reporting the pre-existing container as part of this project.

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
fatal-signal line from stderr, and `web/src/components/editor/OutputPanel.tsx` renders the notice in amber
under the output. `notice` is optional on `ExecuteSuccess` because older records may still sit in a
room's shared `execution` map.

**Piston validates every per-request limit against a configured ceiling, and 400s the whole
request if one exceeds it** (`run_timeout cannot exceed the configured limit of 3000`). So
the numbers in `app/api/execute/route.ts` and the `PISTON_*` vars in `docker-compose.yml` are
one setting in two places: **never raise the route's without raising compose's first.**
Like `PISTON_OUTPUT_MAX_SIZE`, those vars live only in compose, so a Piston started any
other way reverts to defaults — and the defaults are the *tighter* ones (3s run), which
means every run fails outright rather than silently loosening. See `docs/internals/execution.md`.

**Seeding the document.** The starter file — its name and `starterCode(language)` from
`web/src/lib/editor/languages.ts` — is created only after the provider fires `sync`, and only if the `files` map
is still empty. Seeding before sync would insert the boilerplate into a still-empty local doc,
and the CRDT would merge it into the existing document for everyone else in the room. Never
move the seed earlier, and never give Monaco a `defaultValue` — `MonacoBinding` resets the
model to the `Y.Text` contents when it attaches, so it would be discarded anyway. (Since §10.1
the seeded file's id is the fixed string `"main"`; see `docs/internals/room-lifetime-and-files.md` for why a random one
would let two peers seed two identical tabs.)

**Yjs lifecycle is effect-scoped.** The `Y.Doc`, provider, awareness handler, and the per-file
bindings are all created and destroyed inside `web/src/hooks/useCollabRoom.ts`, in two effects keyed on
`roomId`, the editor *and the local user*. **That is why it is one hook and not several**: the
pieces share a single teardown — the binding effect is declared first precisely so its cleanup
runs before the doc dies — so splitting the doc, the provider and the bindings into separate
hooks would
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

**Identity storage is split on purpose.** `web/src/lib/collab/user.ts` keeps the active
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
mechanism that caused it is still live, so keep the guard.** `web/src/lib/editor/monacoLoader.ts` imports
`monaco-editor` at module scope, which touches `window`, so the chain
`RoomGate.tsx → CodeEditor.tsx → monacoLoader.ts` threw
`ReferenceError: window is not defined` whenever the route was server-rendered. React
recovered on the client, so every feature worked and the fault was invisible from a browser.
The UI redesign fixed it the sanctioned way: `RoomGate.tsx` now loads the editor through
`dynamic(() => import("./CodeEditor"), { ssr: false })` at module scope, which keeps Monaco
off the server **without** reintroducing the CDN AMD loader that file exists to avoid (see
"Accounts (Clerk)" in `docs/internals/clerk-auth.md`). `ssr: false` is **illegal in a Server Component** in Next 16
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

**The original v2 spec's sequence diagram drew execution wrong, and the wrong version is the
intuitive one — so it is worth stating what *not* to build.** It showed `FE → WS → Piston`, i.e.
the code travelling to the WebSocket server, which then calls Piston and broadcasts the result.
That is not how this works and must not become how it works: the browser posts to the Next.js route `/api/execute`, which proxies to Piston, and
the *result* is shared through the Yjs `execution` map (see `docs/internals/execution.md`).
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

**Everything a peer writes into a shared type is untrusted input, and there are exactly three
boundaries that narrow it.** One rule covers all of them: **nothing may read a peer-written shared
type directly.**

| Shared type | Boundary | Lives in |
| --- | --- | --- |
| awareness (`user`) | `readPeers()` | `web/src/lib/collab/awareness.ts` |
| the `files` map | `readRoomFiles()` | `web/src/lib/collab/roomFiles.ts` |
| the `execution` map | `readExecutionState()` | `web/src/lib/sandbox/executionState.ts` |

An earlier version of this section named `readPeers` as *the* single point. That was true when it was
written and stopped being true when the `execution` map arrived: it was the one peer-supplied shared
type with no boundary at all, and the audit found the consequence was a one-write, room-wide,
*persistent* denial of service — a peer writing `{status:"success"}` made every **other**
participant's `OutputPanel` throw during render and unwind to `error.tsx`, and reloading landed
straight back in the poisoned record. See "The execution map boundary" below. A fourth shared type
gets a fourth boundary; that is the pattern, not an exception.

**Awareness specifically.** Any peer sets its own `user` field to whatever it
likes — it never passes through our form, so sanitizing at the input boundary proves
nothing. `readPeers()` turns that raw state
into values the UI may render: names are re-sanitized (React escapes them, but an unbounded
or control-character name still wrecks the layout) and a colour failing `HEX_COLOR`
(`/^#[0-9a-f]{6}$/i`, exported from `web/src/lib/collab/awareness.ts`) falls back to grey instead of
reaching an inline `style` or the cursor `<style>` tag. Without that check a peer can send
`red } body { display: none } .x {` and restyle every other participant's page; this was
verified exploitable before the guard was added.

The user bar and `web/src/lib/collab/cursorStyles.ts`'s `renderAwarenessStyles` (the remote-cursor `<style>`
block) both consume `readPeers`'s output rather than touching `awareness.getStates()`
directly — neither may read raw awareness state itself. Anything new that renders a remote
name or colour (join/leave toasts) must go through `readPeers` too.

**`readPeers()` also deduplicates names and colors.** Two peers can independently end up
with the same short name (two "Naman Singla"s both display as `Naman S.`) or the same colour
(an 8-colour palette in `web/src/lib/collab/user.ts`'s `CURSOR_COLORS`, picked at random per joiner with no
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

## Environment variables

| Var | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_WS_URL` | `web/.env.local` | WebSocket server URL. Defaults to `ws://localhost:8080`; production points at the Railway `wss://` URL. **Also the source of the room-routes HTTP base** — `web/src/lib/collab/rooms.ts` swaps the scheme, so there is no separate variable to keep in sync. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `web/.env.local` | Clerk API keys. `next build` still succeeds without them (`proxy.ts` doesn't run at build time) and `next dev` still boots, because `@clerk/nextjs` falls back to *keyless mode* and provisions a throwaway instance under `.clerk/` (gitignored, holds that instance's secret key). **An earlier version of this table claimed a production start 500s the whole site without them. That is false** — measured on `@clerk/nextjs` 7.6.2 by running `NODE_ENV=production next start` with both keys removed *and* `.clerk/` deleted, so keyless could not mask it: `/` served 200 and `/robots.txt` 404, exactly as with keys. Missing keys degrade auth; they do not take the site down. Do not use this as the explanation for a 5xx. |
| `PISTON_API_URL` | `web` | Piston base URL. Defaults to `http://localhost:2000`. **No trailing slash** — `app/api/execute/route.ts` appends `/api/v2/execute`. On Vercel it **used to** hold an ngrok tunnel hostname, which has been shut down for the security reasons in `docs/internals/execution.md`; the deployed value is now stale and execution is a local-only feature. Vercel env changes only reach a *new* deployment, so changing it requires a redeploy. |
| `PISTON_OUTPUT_MAX_SIZE`, `PISTON_RUN_TIMEOUT`, `PISTON_RUN_CPU_TIME`, `PISTON_COMPILE_TIMEOUT`, `PISTON_COMPILE_CPU_TIME`, `PISTON_RUN_MEMORY_LIMIT`, `PISTON_COMPILE_MEMORY_LIMIT` | `docker-compose.yml` | Ceilings inside the Piston container, **not** app config — they exist only in compose, and Piston rejects any per-request limit above them. Keep in step with the constants in `app/api/execute/route.ts`. |
| `PORT` | `server/.env` | Port for both the WebSocket upgrade and the room HTTP routes. Defaults to `8080`. |
| `ROOM_GRACE_MS` | `server/.env` | How long an emptied room lingers before destruction. Defaults to `10000`. |
| `ROOM_RESERVATION_MS` | `server/.env` | How long a created-but-never-entered room stays claimable. Defaults to `300000`. |
| `DATABASE_URL` | `web/.env.local` **and** `server/.env` | Neon's **pooled** connection string (host contains `-pooler`). Used at runtime by `web/src/lib/data/db.ts` and `server/src/storage/db.js`. **Optional in `server/`** — unset, `db.js` opens no pool and `saveDeadRoom()` is a no-op, so the sync server boots and serves rooms exactly as in v1. |
| `DIRECT_URL` | `web/.env.local` only | Neon's **unpooled** string, used by `prisma migrate` alone. Not interchangeable with `DATABASE_URL` — see `docs/internals/snapshots-and-postgres.md`. The sync server has no counterpart because it never migrates. |
| `CLERK_SECRET_KEY` | `web/.env.local` **and** `server/.env` | In the app, Clerk's usual server key. In `server/`, used *only* by `verifyToken` on the WebSocket. **Optional in `server/`** — unset, no token is verified, no room has members and nothing is written, so the guest flow never depends on auth infrastructure. Must be the **same Clerk instance** as the frontend's publishable key: a mismatched key fails every token with no visible symptom at all (rooms work; snapshots simply never appear), which is why `auth/clerk.js` warns once per process. |
| `MEMBER_MIN_CONNECTED_MS` | `server/.env` | How long a signed-in participant must be connected before they can earn a `dead_room_members` row. Defaults to `60000`. Only half the threshold — see "Who a dead room belongs to" in `docs/internals/snapshots-and-postgres.md`. **The frontend hardcodes this default too** (`web/src/lib/data/persistence.ts`, for §10.8's chip), and cannot see this variable — so overriding it here silently desynchronises the in-room estimate from the rule it estimates. |
| `SNAPSHOT_FLUSH_MS` | `server/.env` | Ceiling on how long a shutdown waits for snapshot writes. Defaults to `20000`. A ceiling, not a delay — but since 7.5 it bounds a *drain*, not one batch: N queued rooms take `ceil(N / POOL_MAX) × per-write`, measured ~6.6s for 40 rooms against a warm Neon. An empty queue still shuts down in about half a second. |
| `SNAPSHOT_WRITE_LIMIT`, `SNAPSHOT_WRITE_WINDOW_MS` | `server/.env` | The snapshot write pacing, keyed on the room creator's IP. Default `60` per `60000`ms — deliberately *not* `POST /rooms`' 10; see `docs/internals/limits.md`. Over-limit writes wait rather than being dropped. Lower both to exercise the deferral path in seconds. |
| `DB_CONNECT_TIMEOUT_MS` | `server/.env` | Per-attempt Postgres connect timeout. Defaults to `10000`. Must stay **under** `SNAPSHOT_FLUSH_MS` and **over** a Neon cold start — see `docs/internals/snapshots-and-postgres.md`. Now checked at boot rather than merely documented: a warning fires if it is `>=` the flush deadline. |
| `TRUSTED_PROXY_HOPS` | `web/.env.local` **and** `server/.env` | How many proxy hops in front of the process to trust in `x-forwarded-for`. Default `1`, correct for both Railway and Vercel. The rate-limit key is the **right-most minus (hops − 1)** entry. `0` ignores the header entirely (direct connections only); raise it only if a CDN sits in front. An over-count clamps to the left-most, i.e. degrades to the old forgeable behaviour rather than to a wrong bucket. **Under-counting is the failure to watch**: everyone behind a CDN collapses into one bucket. |
| `CLERK_AUTHORIZED_PARTIES` | `server/.env` | Optional, comma-separated app origins the session token's `azp` claim must match. **Unset means unchecked, on purpose.** `@clerk/backend` fails a token whose `azp` is *absent* just as hard as one that mismatches, so a wrong value fails every token with the same invisible symptom as a wrong secret key: rooms work, snapshots never appear. Vercel previews have per-deployment hostnames and must leave this unset. |
| `ROOM_CREATE_LIMIT`, `ROOM_CREATE_WINDOW_MS` | `server/.env` | `POST /rooms` rate limit. Default `10` per `60000`ms, unchanged from before it was made configurable. **Raise it (300) to run the e2e suite** — see "Testing". Floor of 1 on both: a limit of 0 makes `recent.length >= 0` always true and no room could ever be created. |

## Not built yet

**Three features remain unbuilt: in-room chat, room passwords, and room names.** So there is no
chat, no password, and `/profile` titles every card with the raw `room_id`. **Room names are the
only one that needs a migration** — multi-file needed none, because the schema had already shaped
`files` as a `jsonb` array and `language` as nullable for exactly that. Redis pub/sub for
horizontal scaling is not on the list at all; it is explicitly out of scope. The README's *Future
improvements* section is the authoritative version of this list.

**Everything else v2 set out to build is built**, plus the extras: multi-file rooms, stdin,
keyboard shortcuts, snapshot deletion, the last-person-leaving warning, a UI/UX redesign outside
the original plan, a repository reorganization, and an audit that added the test suite and CI.

**What the audit deliberately did not cover** (recorded because "295 tests, all green" otherwise
reads as "everything was checked"): the CSP ships **report-only** pending a signed-in browser pass;
there is **no signed-in e2e tier** (sign-in → snapshot → `/profile` → delete needs Clerk test users
— the membership *arithmetic* is covered hermetically, the browser journey is not); no real
screen-reader pass was done; and CI cannot run privileged Piston, real Clerk, or a Neon cold start.
Full list with reasons: `docs/TESTING.md` §12.

Four standing limitations, none of them bugs and none currently worth closing:

- **Documents are in-memory only — room state does not survive a sync-server restart.** A restart
  wipes the room registry too, so every client still in a room gets its reconnect refused and is
  sent home. Dead-room snapshots do not change this: they are written when a room dies *normally*,
  and a crashed server still loses whatever was open.
- **`/profile`'s read path is unlimited.** Every view is one uncached Neon query, bounded only by
  Clerk auth and a single indexed lookup. Nothing stops a signed-in user refreshing in a loop — so
  if that path ever grows a second query or an unindexed one, revisit it.
- **The frontend's rate limiter counts per serverless instance, not globally.** This is the one
  thing missing Redis genuinely costs, and it stays: a per-request DB round trip on the hot execute
  path is a worse trade than the documented approximation. Adding Postgres did not make it a
  candidate fix.
- **Execution is local-only.** Hosting Piston somewhere always-on (a VPS permitting privileged
  containers) is the single roadmap item that would change that — see `docs/internals/execution.md`.

## The public-facing docs

Five audiences, and they do not overlap:

| File | Audience | Rule |
| --- | --- | --- |
| `README.md` | Developers, recruiters, beginners | What it is, how to run it, what it does, what is *not* built. Never internal debugging history. |
| `CLAUDE.md` + `docs/internals/` | Whoever edits the code next | The why: gotchas, rejected alternatives, invariants, measurements. |
| `docs/TESTING.md` | Contributors and reviewers | The audit: procedure, case IDs, numbers, and §12's honest list of what is unproven. |
| `docs/DEPLOYMENT.md` | Anyone hosting it | The runbook for both paths: one VPS (Run works), or managed hosting (Run does not). Beginner-level detail on purpose. |
| `docs/learning.md` | Anyone learning *from* it | The teaching document: concepts from zero, six end-to-end walkthroughs, and every bug retold as a transferable lesson. |

`docs/learning.md` is the one file allowed to retell debugging history, and that is why it exists
rather than being a README section. It **derives from these notes and is never the source** — when a
gotcha here is rewritten because it turned out false, the matching lesson there is wrong too, in a
way nothing detects. It deliberately contains **no setup instructions** (the README and
`DEPLOYMENT.md` own those), and every bug in it is real, with a case ID in `TESTING.md` §5.

**The README leads with why the app is not deployed, and that framing is deliberate.** The blocker
is Piston and only Piston. `docs/DEPLOYMENT.md` is the escape hatch that keeps that honest: the
README explains *why* it is not deployed, the guide explains *how* to deploy it if someone wants
to. The guide's single-VPS path is recommended precisely because it keeps Piston on loopback with
the frontend on the same host — **no authentication is needed because nothing external can reach
it.** Its managed-hosting path ships with execution disabled rather than teaching anyone to expose
Piston; if that changes, the shared-secret header in `route.ts` lands in the same change.

**Do not re-add live deployment URLs to the README** without the user asking. Hosting projects do
still exist, but pointing at them would be worse than saying nothing: Run cannot work there without
Piston, and the reorganization renamed `collab-code-editor/` to `web/`, which invalidates the
Vercel project's *Root Directory* setting — with that stale, every path returns a bare `NOT_FOUND`
while the dashboard still reports "Ready". A link in that state reads as a broken project rather
than an intentional limitation.

These files must never disagree. When a change makes one wrong, fix all of them in the same
commit — a stale README is the version most people read.
