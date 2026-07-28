# Real-Time Collaborative Code Editor

A multiplayer code editor: Yjs CRDT sync over WebSockets, plus sandboxed multi-language
execution via a self-hosted Piston instance.

## Repo layout

Two independent workspaces. **There is no root `package.json`** — install and run each separately.

| Path | What it is |
| --- | --- |
| `collab-code-editor/` | Next.js 16 (App Router) frontend. Monaco editor, room routing, and the `/api/execute` proxy to Piston. |
| `server/` | Standalone Node.js WebSocket server speaking the Yjs sync protocol. Deployed to Railway. |

Key files:
- `collab-code-editor/app/components/CodeEditor.tsx` — the whole client-side Yjs stack (doc, provider, awareness, Monaco binding)
- `collab-code-editor/app/room/[roomId]/page.tsx` — dynamic room route; `roomId` is the Yjs document name
- `collab-code-editor/app/api/execute/route.ts` — server-side proxy to Piston
- `server/yjsConnection.js` — the only place that speaks the Yjs wire protocol

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

**Seeding the document.** Starter code is inserted into the `Y.Text` only after the provider
fires `sync`. Seeding before sync would insert the boilerplate into a still-empty local doc,
and the CRDT would merge it into the existing document for everyone else in the room. Never
move the seed earlier, and never give Monaco a `defaultValue` — `MonacoBinding` resets the
model to the `Y.Text` contents when it attaches, so it would be discarded anyway.

**Yjs lifecycle is effect-scoped.** The `Y.Doc`, provider, awareness handler, and binding are
all created and destroyed inside one effect keyed on `roomId`. Do not hoist the `Y.Doc` into
component state — a cleanup that destroys a doc nothing recreates breaks both room switching
and React StrictMode's dev remount.

## Architecture invariant

Editing sync and code execution are deliberately **separate systems**. Editing is low-latency
and always-on; execution is bursty, resource-heavy, and handles untrusted input. Coupling
them would let a slow or crashed execution request degrade live editing for a whole room.

Within sync, there are likewise two protocols on the same socket:
- **Document updates** — durable CRDT ops, merged and replayed across reconnects
- **Awareness** — ephemeral cursor/selection/user state, dropped entirely on disconnect

Don't merge them: cursor positions must never enter document history.

## Environment variables

| Var | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_WS_URL` | `collab-code-editor/.env.local` | WebSocket server URL. Defaults to `ws://localhost:8080`; production points at the Railway `wss://` URL. |
| `PISTON_API_URL` | `collab-code-editor` | Piston base URL. Defaults to `http://localhost:2000`. |
| `PORT` | `server/.env` | WebSocket server port. Defaults to `8080`. |

## Not built yet

Postgres persistence, Redis pub/sub for horizontal scaling, and execution resource limits are
all on the roadmap but unimplemented. **Documents are in-memory only — room state does not
survive a WebSocket server restart.** Piston is local-only; code execution does not work on
the deployed site.

@collab-code-editor/AGENTS.md
