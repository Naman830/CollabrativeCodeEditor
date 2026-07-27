# CLAUDE.md

Project context for Claude Code. Covers all three services in this repo.

A real-time collaborative code editor: multiple people edit the same document with live
multi-cursor presence (Yjs CRDT), and run the result in a sandbox (self-hosted Piston).
It's a portfolio/learning project built around two genuinely hard problems — distributed
state convergence and untrusted-code isolation — and it deliberately avoids `eval()` or
any client-side execution.

---

## ⚠️ Read this before trusting the READMEs

`README.md` (380 lines) is the main design doc and is mostly excellent, but it has drifted
from the code **in both directions**. Verify against source before acting on any of these:

| README claim | Where | Reality |
|---|---|---|
| "Redis pub/sub is now **fully implemented** … multi-instance convergence now works end-to-end" | `README.md:252-259` (v0.6) | **False.** Scaffold only. See below. |
| "`exec-server/` is still a bare passthrough proxy with no queue/worker pool yet" | `README.md:198-205`, `:261` | **False.** The queue and worker pool are implemented and wired. |
| v0.5 checklist: "these TODOs are currently stubbed … every check below will fail" | `README.md:223` | **False**, same reason — the queue shipped. |
| "There's no room routing, persistence, or auth yet" | `server/README.md:3` | Room routing and persistence **are** implemented. Only "no auth" is still true. |
| "MIT License. See `LICENSE` file" | `README.md:377-379` | There is **no `LICENSE` file** in the repo. |

**On Redis specifically:** the v0.6 section is the *only* place that claims it works. The
status header (`README.md:5`), the "Cross-Instance Sync (scaffold)" section
(`README.md:168-192`), the setup notes (`:342`) and the roadmap checkbox (`:371`) all
describe it accurately as scaffolded. Trust those, not v0.6.

Verified state of the Redis relay:

- `server/redis/sync.js:43-59` — the `Y.Doc` `"update"` listener is attached, but its body
  is only `void update; void origin; void roomId; void INSTANCE_ID;`.
- `server/redis/awareness.js:51-89` — identical shape for the awareness relay.
- `subscribeRoom` (`sync.js:86`) and `subscribeRoomAwareness` (`awareness.js:116`) are
  exported but **never called from anywhere**.
- `grep -rn "publisher.publish\|subscriber.subscribe" server/` returns **nothing**.
- **12** `TODO(core-logic)` markers remain across `server/`.

So `npm run dev:cluster` + `?wsPort=8081` will *not* converge across instances today. The
tooling to test it exists; the relay does not.

---

## Feature backlog

`FEATURES.md` at the repo root is the master checklist of everything this app is missing —
auth, save/export/share, graceful shutdown, tests, CI, and the rest — each item carrying a
`file:line` reference to the evidence.

**When you finish a feature from that list you must (a) tick its checkbox in `FEATURES.md`
and (b) update this file** — "Actual current state" at minimum, plus "Invariants — do not
break these" if the change adds a load-bearing constraint, and "Gotchas" if it adds a trap.
Treat that as part of the task, not a follow-up.

---

## Repo layout

**This is not a monorepo.** Three independent npm projects side by side — no root
`package.json`, no workspaces, no turbo/nx. Each has its own lockfile and `node_modules`;
`npm install` runs per service.

| Path | Role | Port | Runtime |
|---|---|---|---|
| `collab-code-editor/` | Next.js 16 App Router frontend + `/api/execute` BFF proxy | 3000 | ESM + TypeScript (strict) |
| `server/` | Yjs WebSocket sync server (`ws` + `y-websocket`) + Postgres persistence | 8080 (8081 in cluster mode) | CommonJS JS, Node ≥22.12 |
| `exec-server/` | Express execution service: queue → worker pool → Piston | 4000 | CommonJS JS, Node ≥22.12 |
| (Docker) | Self-hosted Piston sandbox | 2000 | `ghcr.io/engineer-man/piston` |

Notable single files: `collab-code-editor/app/components/CodeEditor.tsx` is **603 lines and
is the entire UI** — the only real component. `server/yjsConnection.js` holds the whole
connection lifecycle and is the densest logic in the repo.

---

## Commands

Each service needs its own `.env` (`cp .env.example .env`) and its own `npm install`.

```bash
# Piston sandbox — run this first, from collab-code-editor/
docker compose up -d          # starts `piston` + one-shot `piston-init` runtime installer

# Frontend (collab-code-editor/)
npm run dev                   # next dev, :3000
npm run build
npm run lint                  # eslint 9 flat config
npx tsc --noEmit              # type-check

# WebSocket sync server (server/)
npm run dev                   # node index.js, :8080
npm run dev:cluster           # two instances on :8080 and :8081 via concurrently
npm run prisma:migrate        # prisma migrate dev (uses DIRECT_URL)
npm run prisma:generate       # also runs automatically on postinstall
npm run prisma:studio
npm run db:test               # manual DB smoke script, not a test-runner test

# Execution service (exec-server/)
npm run dev                   # node index.js, :4000
```

`server/` needs `DATABASE_URL` (Neon pooled), `DIRECT_URL` (Neon direct — Migrate only,
PgBouncer can't hold Migrate's session advisory locks) and `REDIS_URL` (see gotcha below).

---

## Deployment

Live as of 2026-07-27. Two of the three services are deployed; execution is not.

| Service | Host | URL |
|---|---|---|
| `collab-code-editor/` | Vercel, project `real-time-collabrative-code-editor-with-sandbox-execution` | https://real-time-collabrative-code-editor-two.vercel.app |
| `server/` | Railway, service `CollabrativeCodeEditor` | `wss://collabrativecodeeditor-production.up.railway.app` |
| `exec-server/` + Piston | **not deployed** | — |

Both deploy from `main` on push via the GitHub integration.

**Vercel's Root Directory must be `collab-code-editor`.** This repo is not a monorepo and
has no root `package.json` (see "Repo layout"), so with the default empty root directory
Vercel finds no framework, builds nothing, and publishes an **empty deployment** — while
still reporting "Ready" with a green "Deployment successful". Every path then returns a
bare `x-vercel-error: NOT_FOUND` from the platform edge, *not* Next's own 404 page. The
distinguishing signal is in the response headers: a real Next deployment sets
`x-matched-path` and `x-nextjs-prerender`; an empty one sets neither. Root Directory is
**not settable from `vercel.json`** — it's a project setting (Settings → Build & Deployment
→ Root Directory, or `PATCH /v9/projects/{id}` with
`{"rootDirectory":"collab-code-editor","framework":"nextjs"}`). Changing it does **not**
trigger a rebuild; redeploy manually afterwards.

**Vercel env vars.** Only `NEXT_PUBLIC_WS_URL` is set (production + preview + development),
and it must use the `wss://` scheme: the fallback at `CodeEditor.tsx:31` is
`ws://localhost:8080`, which a browser blocks as mixed content on an HTTPS page, so an unset
var manifests as a permanent silent "connecting" rather than an error. Being `NEXT_PUBLIC_*`
it is inlined into the client bundle at build time, so changing it needs a redeploy, not a
restart — grep the deployed chunk to confirm it actually took. `EXEC_SERVER_API_URL` is
deliberately unset; see below.

**A plain HTTP GET to the Railway URL returning `Upgrade Required` is correct** — that's
`ws` answering a non-upgrade request, and it means the server is healthy. Don't debug it.

**Execution is not deployed, on purpose.** Self-hosted Piston needs a *privileged* container
(`isolate` + cgroups), which Railway doesn't allow, so `docker-compose.yml` can't be lifted
there as-is. With `EXEC_SERVER_API_URL` unset, `/api/execute` fails fast (~0.8s) into the 502
at `route.ts:120-125` — "Could not reach the code execution service." That is the intended
degraded state, not a bug. The two ways out are the public Piston API at
`emkc.org/api/v2/piston` (rate-limited to ~5 req/sec, and you lose control of the runtime
versions `LANGUAGE_MAP` pins at `route.ts:7`) or hosting Piston on Fly.io / a VPS.

Smoke-testing a deploy without a browser — two headless clients must converge:

```bash
# from the repo root; prints PASS or FAIL
NODE_PATH=server/node_modules node -e '
const Y=require("yjs"),{WebsocketProvider}=require("y-websocket"),WS=require("ws");
const U="wss://collabrativecodeeditor-production.up.railway.app",R="smoke-"+Date.now();
const mk=()=>{const d=new Y.Doc();return{p:new WebsocketProvider(U,R,d,{WebSocketPolyfill:WS}),t:d.getText("monaco")}};
const a=mk(),b=mk();
a.p.once("sync",()=>a.t.insert(0,"ping"));
setTimeout(()=>{console.log(b.t.toString()==="ping"?"PASS":"FAIL: "+b.t);process.exit()},8000);'
```

It logs `Unable to compute message` once per client. That's just instance-hello (type 42)
reaching a handler the headless client never registered — the browser registers it at
`CodeEditor.tsx:288` — so it actually confirms the handshake arrived.

---

## The two data paths

**Editing** — everything below is per-room, keyed on the URL segment of `/room/[roomId]`:

```
Monaco ──MonacoBinding(y-monaco)──▶ Y.Doc/Y.Text
   └── WebsocketProvider(y-websocket) ──▶ server/ setupWSConnection ──▶ shared Y.Doc (getYDoc)
                                                                          └──▶ debounced snapshot ──▶ Postgres (Prisma/Neon)
```

Presence rides the *same* socket as a distinct Yjs message type (awareness), not a second
connection. Awareness is ephemeral and never merged into doc history. Works **within one
instance only** — see the Redis note above.

**Execution** — no streaming anywhere; one JSON blob per run:

```
CodeEditor.handleRun ──▶ POST /api/execute (Next route: validate, map language, cap size)
                    ──▶ POST exec-server:4000/execute
                    ──▶ FIFO queue ──▶ fixed worker pool ──▶ POST piston:2000/api/v2/execute
```

Languages (5): JavaScript 18.15.0, TypeScript 5.0.3, Python 3.10.0, Java 15.0.2, C++ (g++) 10.2.0.

---

## Invariants — do not break these

**`server/yjsConnection.js`** — every ordering step here is load-bearing:

1. `sendInstanceHello(ws)` fires **before** the Postgres round-trip (`:94`), because a cold
   Neon connect takes seconds and the status pill would otherwise sit blank.
2. `ws.pause()` before the async Prisma call, `ws.resume()` last (`:101`, `:173`). Without
   it, a fast client completes its initial sync against an **empty** doc — `setupWSConnection`
   sends sync step 1 synchronously and knows nothing about Postgres.
3. `prisma.room.upsert`, **not** find-then-create (`:108-112`) — two clients opening the same
   new room would otherwise both see "not found" and double-create.
4. The persistence listener is attached **after** the initial `Y.applyUpdate` (`:125-128`), so
   restoring a snapshot doesn't immediately trigger a redundant save.
5. The `"close"` handler is registered **after** `setupWSConnection` (`:165`). y-websocket
   registers its own close handler first and removes the socket from `ydoc.conns`, so by the
   time this one runs `ydoc.conns.size === 0` genuinely means "last client."
6. Instance-hello uses WS message type **42**, deliberately outside y-websocket's reserved
   range (sync=0, awareness=1, auth=2, queryAwareness=3), so it round-trips untouched through
   the dispatcher. The client registers `provider.messageHandlers[42]` (`CodeEditor.tsx:288`).

**`collab-code-editor/app/components/CodeEditor.tsx`:**

- `y-websocket` and `y-monaco` are **dynamically imported, client-side only** (`:275`, `:342`) —
  they touch `window`/`WebSocket` at module scope.
- Default content is seeded only on the provider `"sync"` event **and** `yText.length === 0`
  (`:301`). Seeding at mount previously CRDT-merged a second copy of `DEFAULT_CODE` into
  existing rooms.
- `awareness.setLocalState(null)` before `destroy()` (`:326`) so peers drop the cursor
  immediately instead of waiting for the socket close.
- `renderAwarenessStyles()` (`:75`) regenerates the **whole** `<style>` block on every
  awareness change — a departed client's rule is simply absent next time, so no cleanup logic
  is needed. Don't "optimize" this into incremental patching.
- `resolveWsUrl()`'s `?wsPort=` override is gated on `NODE_ENV !== "development"` (`:37`) so it
  compiles out of production builds. Keep it that way.

**`exec-server/`:**

- `piston/buildExecuteRequest.js:39-42` **always overwrites** `compile_timeout`, `run_timeout`,
  `compile_memory_limit`, `run_memory_limit` on the caller's body — a client must not be able
  to loosen its own limits.
- `worker/workerPool.js:117` checks `!pistonRes.ok` **before** calling `classifyResult`. A
  Piston error body has no compile/run stage and would otherwise classify as a fake empty
  success.

---

## Gotchas that will cost you real time

- **A Vercel deploy of this repo 404s on every path unless Root Directory is
  `collab-code-editor`** — and it still reports "Ready". See "Deployment" for the full
  signature and fix.
- **`server/` cannot boot without `REDIS_URL`.** `index.js` → `yjsConnection.js` →
  `redis/sync.js` → `redis/client.js:38` **throws at import time** if it's unset — even though
  nothing in the codebase actually uses Redis yet.
- **`LANGUAGE_MAP` and `REQUIRED_RUNTIMES` must stay in sync** —
  `collab-code-editor/app/api/execute/route.ts:7` (request-time aliases) and
  `collab-code-editor/scripts/install-piston-runtimes.js:20` (installable package names).
  Note the deliberate name mismatches: `node`→javascript, `gcc`→c++.
- **If `docker logs piston_init` doesn't end with `all N runtimes verified available. done.`,
  code execution silently returns empty output.** Check that log before assuming the editor
  is broken.
- **`exec-server` returns an envelope**, `{ pistonStatus, data, result }` — not a flat Piston
  response. Reading `run`/`status`/`stage` off the top level with `??`/`?.` silently produced
  `{success:true, stdout:"", exitCode:null}` on *every* run (fixed in `2b3b086`). The
  `ExecServerResponse` type at `route.ts:63` exists to make that a type error next time.
- **64 KiB code cap** at `route.ts:95` — `express.json()`'s 100kb default returned an HTML
  error page that surfaced as a confusing 502.
- **queued→running is a 350ms client-side `setTimeout` heuristic** (`CodeEditor.tsx:366`), not
  a server signal. `exec-server` holds the HTTP request open for the whole job; there's no
  SSE, no xterm, no stdin/args support.
- **`roomId` is not sanitized server-side.** `yjsConnection.js:87` takes it straight off the
  URL path, and `redis/channels.js:10-13` flags that it can contain `:` and address other
  rooms' channels once pub/sub is wired. The browser client happens to `encodeURIComponent`
  it, but any direct WS client can send a raw path.
- **No auth anywhere.** Any known room id is joinable; there are no sessions, tokens, or
  middleware.
- **No room eviction** — `getYDoc`'s map grows unbounded for the process lifetime.
- **`kill -9` still loses up to 4s of edits.** Flush-on-last-disconnect covers a room going
  idle, not process death; that would need a graceful-shutdown hook.
- **`memory_limit_exceeded` is a heuristic**, not a guarantee — signal-killed *and* memory
  ≥90% of the limit (`classifyResult.js:27`). A SIGSEGV under memory pressure can be
  misclassified.
- The `@/*` path alias exists (`tsconfig.json:21-23`) but is **never used** — every import is
  relative.
- `server/generated/prisma/` is gitignored and regenerated by the `postinstall` hook.

---

## Conventions

- **Split module systems.** The frontend is ESM + TypeScript strict. `server/` and
  `exec-server/` are plain CommonJS `require()` JavaScript that use **JSDoc typedefs instead
  of TypeScript** (e.g. `SyncEnvelope` in `redis/channels.js`). Match the local file's style;
  don't introduce TS into the two servers.
- **Comment style is the dominant convention here and should be matched.** Comments explain
  *why*, at length, and cross-reference other services by file path. Fixed regressions are
  documented inline where they were fixed, not just in git history (see `route.ts:166-172`
  and `:91-94`). Unimplemented decisions are marked `TODO(core-logic)` with the in-scope
  variables enumerated.
- **Error handling:** HTTP status is carried on the error itself via
  `Object.assign(new Error(msg), { status: 502 })`, unwrapped in `exec-server/index.js`. The
  Next route uses a tagged envelope `{ success: false, kind: "rejected" | "error", error }` so
  the client can tell queue rejection from real failure.
- **Degrade vs fail-loud is deliberate.** Postgres unreachable → log and continue in-memory
  (`yjsConnection.js:117-121`). Redis blip → log only (`redis/client.js:64-68`). A thrown job →
  caught so the worker loop survives. But a missing `REDIS_URL` throws at import, because
  that's a deployment misconfiguration, not a runtime condition.
- **Logging** is bare `console.log`/`console.error` — no logger, no levels, no request ids.
- **Naming:** camelCase JS modules, PascalCase React components, `SCREAMING_SNAKE` constants,
  `DEFAULT_*` fallbacks paired with a parse-and-validate guard (repeated 7× in
  `exec-server/config/index.js`).
- **Frontend styling** is Tailwind v4 CSS-first (`@import "tailwindcss"` in `globals.css`, no
  `tailwind.config.*`), with hardcoded VS Code hex colors inline. No state library — `useState`
  and `useRef` only.
- **Next.js 16.2.10 differs from training data.** Read the relevant guide in
  `node_modules/next/dist/docs/` before writing Next.js code, and heed deprecation notices.

---

## Testing

**There are no automated tests.** No test runner, no `test` script, no `*.test.*` or
`__tests__/` anywhere in the repo. `server/scripts/testDbConnection.js` (`npm run db:test`) is
a manual DB smoke script, not a test.

What to run instead:

- `npm run lint` and `npx tsc --noEmit` — **frontend only**; the two servers have no linter
  and no TypeScript.
- The four manual checklists in `README.md`: Persistence (`:146`), Multi-Instance (`:186`),
  Execution Queue v0.5 (`:221`), Horizontal Scaling v0.6 (`:264`). Note the v0.5 preamble and
  the v0.6 checklist both carry the staleness described at the top of this file — the v0.5
  checks should now pass, and the v0.6 cross-instance checks cannot pass yet.

If you touch `server/yjsConnection.js` or the Prisma schema, walk the persistence checklist by
hand — it's the only coverage that exists.

---

## Actual current state

Working: real-time CRDT sync, room routing, multi-cursor presence, Postgres persistence
(load-on-connect, 4s debounced snapshot, flush-on-last-disconnect), sandboxed execution with a
queue, worker pool, per-job timeout, backpressure, resource limits, and 7-way failure
classification surfaced as distinct UI states.

Scaffolded but not implemented: the Redis cross-instance relay for both document and awareness
updates (12 `TODO(core-logic)` markers). The deliberate open question is *where* the subscribe
belongs relative to the Neon snapshot load and the client's initial sync — `yjsConnection.js:156`.
A second open question sits in `awareness.js`: how to reap ghost cursors when a remote instance
dies without a clean disconnect.

Deployed: frontend on Vercel, `server/` on Railway, verified converging end-to-end. Code
execution is **not** deployed — `exec-server/` and Piston have no host, so the Run button
returns a clean 502 in production. See "Deployment".

Not started: reconnect/resync handling, room eviction/TTL, auth, and a graceful-shutdown
flush.
