# FEATURES.md — missing-feature backlog

Every gap in this app, in one checklist. The core works (CRDT sync, room routing, Postgres
persistence, multi-cursor presence, queued sandbox execution with 7-way failure
classification); everything below is what it *doesn't* have.

Each item carries a `file:line` reference to the evidence, matching this repo's convention of
cross-referencing by path. Sections are ordered roughly by value.

**Workflow:** pick an item → build it → tick its box `[ ]` → `[x]` → update `CLAUDE.md`.
See "How to complete an item" at the bottom. Ticking without updating `CLAUDE.md` is
incomplete work.

---

## 1. Authentication & Identity

Nothing in this category exists. This is the largest single gap.

- [ ] **Auth provider + login/signup** — no `middleware.ts` anywhere in the repo; no NextAuth / Clerk / Auth0 / jsonwebtoken / bcrypt in any of the three `package.json` files.
- [ ] **`User` model in Prisma** — `server/prisma/schema.prisma:15-20` has exactly one model, `Room`. No `User`, no `RoomMember`, no relations.
- [ ] **Room ownership / private rooms** — any guessed room id is joinable by anyone. Acknowledged in-code at `collab-code-editor/app/components/CodeEditor.tsx:82-83`.
- [ ] **WebSocket auth on connect** — `server/yjsConnection.js:68-89` validates the roomId *shape* but never authenticates the client. y-websocket reserves message type `auth=2`, currently unused (see the comment at `yjsConnection.js:33`).
- [ ] **Real usernames for presence** — the name is a random `User NNNN` with a random palette color, and is unchangeable (`CodeEditor.tsx:53-68`, `:333-338`).
- [ ] **Participant roster UI** — awareness state already carries every peer, but no "who's in this room" list is rendered anywhere.
- [ ] **Shared secret between the Next proxy and exec-server** — `POST /execute` is fully open (`exec-server/index.js:17-34`). Anyone who finds the host can run arbitrary code on it.

## 2. Save / Share / Export

Nothing in this category exists. Note the doc *is* already auto-persisted (4s debounced
snapshot + flush-on-last-disconnect), so a "save" control is UX reassurance and export — not
new durability. Real durability is §3's graceful-shutdown item.

- [ ] **Save-status indicator ("Saving… / Saved")** — needs a small server→client signal from the existing debounce in `server/yjsConnection.js`; model it on the existing out-of-band instance-hello message type 42.
- [ ] **Download as file** — no export path anywhere in `CodeEditor.tsx`.
- [ ] **Copy code to clipboard** — absent.
- [ ] **Copy share link / invite button** — absent; the room id is rendered as read-only text at `CodeEditor.tsx:465-467`.
- [ ] **Filename field** — execution hard-codes `main.<ext>` at `collab-code-editor/app/api/execute/route.ts:118`.
- [ ] **Multi-file / editor tabs** — single buffer only. Piston already accepts a `files[]` array, so the backend supports this without changes.

## 3. Durability & Production Hardening

- [ ] **Graceful shutdown flush (`SIGTERM` / `SIGINT`)** — **highest value for the effort.** No signal handler exists in `server/`; a Railway redeploy or a `kill -9` loses up to `PERSIST_DEBOUNCE_MS = 4000` (`server/yjsConnection.js:48`) of edits.
- [ ] **Health endpoint on `server/`** — `server/index.js` (14 lines) constructs a bare `new WebSocketServer({ port })` with no HTTP server, so there is no `/health` and no HTTP route at all. `exec-server` already has one at `exec-server/index.js:13-15` — mirror it.
- [ ] **Rate limiting** — none anywhere. `exec-server` has queue-depth backpressure only (`MAX_QUEUE_DEPTH=100`, `exec-server/config/index.js:13`; 429 at `index.js:18-20`), no per-IP or per-room throttle. `server/` has no connection cap and no max doc size.
- [ ] **Room eviction / TTL** — the y-websocket `docs` map is never evicted (noted in-code at `server/yjsConnection.js:45-46`); `persistedRooms` and `saveTimers` grow unbounded too. No cleanup of stale `Room` rows either.
- [ ] **Redis cross-instance relay** — still scaffold only. 12 `TODO(core-logic)` markers; `subscribeRoom` (`server/redis/sync.js:86`) and `subscribeRoomAwareness` (`server/redis/awareness.js:116`) are exported but never called. **Multi-instance deploys will not converge.** The open design question — where the subscribe belongs relative to the Neon snapshot load and the client's initial sync — is at `server/yjsConnection.js:226-237`.
- [ ] **Ghost-cursor reaping** — when a remote instance dies without a clean disconnect, its awareness entries stick. Noted at `server/redis/awareness.js:143` and `:153`.
- [ ] **Reconnect / resync handling** — not started.
- [ ] **Body-size cap on exec-server** — the 64 KiB cap lives in the Next proxy only (`route.ts:94-101`); exec-server itself relies on `express.json()`'s ~100kb default, so a direct caller bypasses the intended limit.

## 4. Editor UX

- [ ] **Theme toggle / light mode** — `theme="vs-dark"` is hard-coded (`CodeEditor.tsx:503-516`).
- [ ] **stdin support** — `/api/execute` sends only `language` / `version` / `files` (`route.ts:114-120`); Piston accepts `stdin`.
- [ ] **Program args support** — same call site; Piston accepts `args`.
- [ ] **Ctrl/Cmd+Enter to run** — no keyboard shortcut exists.
- [ ] **Clear-output and copy-output buttons** — absent.
- [ ] **Resizable output panel** — fixed `h-48` at `CodeEditor.tsx:553`.
- [ ] **Back-to-home / leave-room link** — absent; there's no way out of a room but the browser's back button.
- [ ] **Font size / editor settings panel** — Monaco options are hard-coded at `CodeEditor.tsx:510-515`.
- [ ] **In-room chat** — absent.
- [ ] **Client-side room-id validation on the landing page** — `collab-code-editor/app/page.tsx:14-18` only `trim()`s the input, but the server enforces `^[A-Za-z0-9_-]{1,64}$` and closes with code 1008 (`server/yjsConnection.js:68-89`, `:144-148`). A malformed id currently fails silently at connect time with no error shown.
- [ ] **Run should read the Y.Doc directly** — *low priority, not a bug.* `handleRun` sends React state `code` (`CodeEditor.tsx:251`, `:355`, `:374`). Verified correct today: `onChange` fires for remote `MonacoBinding` edits too, so `code` does track the merged doc. Reading `yText.toString()` would just remove a redundant second source of truth.
- [ ] **Streaming execution output** — `exec-server` holds the HTTP request open for the whole job; no SSE, no xterm. The queued→running transition is a 350ms client-side `setTimeout` heuristic (`CodeEditor.tsx:366`), not a server signal.

## 5. Project Hygiene

- [ ] **Automated tests** — zero. No test runner, no `test` script, no `*.test.*` or `__tests__/` in any of the three packages. `server/scripts/testDbConnection.js` is a manual smoke script, not a test.
- [ ] **CI** — no `.github/` directory at all.
- [ ] **`LICENSE` file** — absent, despite `README.md:377-379` claiming MIT.
- [ ] **Page metadata** — `collab-code-editor/app/layout.tsx:15-18` still says `title: "Create Next App"`.
- [ ] **`not-found.tsx` / `error.tsx` / `loading.tsx`** — none exist in the app router.
- [ ] **Lint/format for the two servers** — ESLint exists in the Next package only; `server/` and `exec-server/` have no linter or formatter.
- [ ] **README drift** — `README.md`'s v0.6 section falsely claims Redis is "fully implemented"; its exec-server claims are stale in the other direction. The full discrepancy table is already documented at the top of `CLAUDE.md`.
- [ ] **Dockerfiles for the app services** — only `collab-code-editor/docker-compose.yml` exists, and it runs Piston + the one-shot runtime installer, not the app itself.
- [ ] **Deploy `exec-server` + Piston** — blocked, deliberately. Piston needs a *privileged* container (`isolate` + cgroups), which Railway disallows. The two ways out are the public `emkc.org/api/v2/piston` API (rate-limited ~5 req/sec, and you lose the runtime-version pinning at `route.ts:7`) or hosting Piston on Fly.io / a VPS. Until then `/api/execute` fails fast into the intended 502 at `route.ts:120-125`.

---

## How to complete an item

Three steps. All three, in the same change:

1. **Build it** — following the conventions in `CLAUDE.md` (CommonJS + JSDoc in the two
   servers, ESM + strict TS in the frontend; comments explain *why* and cross-reference by
   file path).
2. **Tick the box** here — `[ ]` → `[x]`. If the implementation revealed something the item's
   description got wrong, fix the description too rather than leaving stale text.
3. **Update `CLAUDE.md`** — "Actual current state" at minimum, plus "Invariants — do not break
   these" if the change adds a load-bearing ordering constraint, and "Gotchas" if it adds a
   trap. This is part of the task, not a follow-up.

Since there are no automated tests, also walk the relevant manual checklist in `README.md`
(Persistence `:146`, Multi-Instance `:186`, Execution Queue `:221`, Horizontal Scaling `:264`)
and run `npm run lint` + `npx tsc --noEmit` for any frontend change.
