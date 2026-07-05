# Real-Time Collaborative Code Editor with Sandboxed Execution

A collaborative code editor with real-time multi-cursor sync (CRDT-based) and secure sandboxed code execution — built to explore distributed state management and execution isolation at scale.

🚧 Status: In Progress — single-user editor with sandboxed execution is working locally; real-time multi-tab sync is now live via Yjs + y-websocket + the standalone WebSocket server, with independent per-room documents via URL-based room routing; Redis and Postgres are not wired up yet.

---

## Overview

Pair programming, technical interviews, and classroom coding often happen over screen-share with no shared, executable environment. This project solves that with a lightweight, multiplayer code editor where multiple users can edit the same file simultaneously and run code safely — without relying on `eval()` or client-side execution, which is a common security shortcut in similar portfolio projects.

What makes it technically interesting: keeping edit state consistent across multiple concurrent users without conflicts (via CRDTs) and running arbitrary, untrusted code safely without compromising the host system (via sandboxed execution). These are two distinct hard problems — most tutorials solve neither well.

---

## Demo

*Coming soon — will be added once core editing and execution flows are functional.*

**Live link:** Coming soon

---

## Features

- [x] Real-time multi-tab sync (Yjs CRDT over `y-websocket`, independent rooms via URL routing)
- [ ] Real-time multi-cursor editing
- [ ] Presence indicators (who's online, where they're looking)
- [x] Sandboxed code execution (JavaScript, TypeScript, Python, Java, C++ via a self-hosted Piston instance)
- [ ] Room persistence (reload without losing state)

---

## Tech Stack

| Layer | Technology | Why |
| --- | --- | --- |
| Frontend | Next.js (App Router) | An industry-standard React framework that provides a fast development experience for building the editor interface and collaborative room pages. |
| Code Editor | Monaco / CodeMirror | Free, open-source, and battle-tested editor components with built-in syntax highlighting and a rich editing experience. |
| Sync Engine | Yjs | A CRDT-based library that automatically resolves concurrent edits without conflicts, eliminating the need for custom conflict resolution logic. |
| Realtime Server | Node.js WebSocket Server (separate from Next.js) | Since Next.js API routes are not designed for long-lived connections, a dedicated WebSocket server provides persistent, low-latency, bidirectional communication. |
| Caching / Pub-Sub | Redis | Broadcasts room state across multiple server instances, enabling efficient horizontal scaling. |
| Persistence | PostgreSQL | Provides durable storage, ensuring rooms and documents persist across server restarts. |
| Code Execution | Piston (Open-Source Sandboxed Execution Engine) | Enables secure, multi-language code execution without building a custom Docker-based sandbox, allowing development effort to focus on real-time collaboration and scalability instead of execution isolation. |

---

## Architecture
*Diagram image coming soon — described in text below in the meantime.*

The Next.js frontend holds a `Y.Doc` per editor session, bound to the Monaco editor via `y-monaco`. A `WebsocketProvider` (from `y-websocket`) connects that same `Y.Doc` to the standalone Node.js WebSocket server in `server/`, which speaks the Yjs sync protocol (via `y-websocket`'s server-side `setupWSConnection` utility) instead of a custom message format. Landing on `/` shows a room-join screen where you enter a room ID or generate a new one; that ID becomes the dynamic route segment for `/room/[roomId]` and is passed as the Yjs document name to both the `Y.Doc` setup and the `WebsocketProvider`, so each room gets its own independent, isolated CRDT document — two tabs on the same room ID converge in real time, and a tab on a different room ID never sees those edits. Presence and persistence are not built yet — nothing survives a server restart.

**WebSocket server:** deployed on Railway, URL: `collabrativecodeeditor-production.up.railway.app`

**Why editing sync and code execution are separate systems:**
Editing sync needs to be low-latency and always-on — every keystroke matters. Execution is bursty, resource-heavy, and needs strict isolation from untrusted input. Coupling them would mean a slow or crashed execution request could degrade the live-editing experience for every user in the room. Keeping them decoupled lets each scale, fail, and recover independently.

---

## Key Technical Challenges

- [ ] **CRDT conflict resolution** — Ensuring multiple users editing the same line simultaneously converge to the same final state without manual merge logic. Approach: use Yjs's built-in CRDT algorithm rather than implementing operational transform manually; document the tradeoff in a dedicated write-up below.
- [ ] **WebSocket scaling** — A single Node.js WebSocket server can't hold every connection once traffic grows. Approach: use Redis pub/sub so multiple server instances share room state, with clients able to connect to any instance.
- [ ] **Sandboxed execution security** — Running arbitrary user-submitted code without letting it harm the host system or other users. Approach: route all execution through Piston's isolated sandboxes rather than local `eval()` or unrestricted containers, with per-request CPU/memory/time limits.

---

## CRDT vs Operational Transform

*Full write-up to be added once implementation decisions are finalized — this will compare Yjs's CRDT approach against Operational Transform (used by Google Docs), explaining why CRDTs were chosen for this project (no central server required for conflict resolution, simpler offline/reconnect handling) and the tradeoffs involved (larger metadata overhead per edit).*

---

## Real-Time Sync

Yjs is integrated with the Monaco editor in `collab-code-editor/app/components/CodeEditor.tsx`, and is now synced across tabs/clients over the network.

- A `Y.Doc` and `Y.Text` are created per editor session and bound to the Monaco model via `y-monaco`'s `MonacoBinding`, so keystrokes flow into the CRDT.
- A `WebsocketProvider` (from `y-websocket`) connects that same `Y.Doc` to the standalone WebSocket server in `server/`, so edits are broadcast to every other client in the same room and merged via Yjs's CRDT — open the editor in two tabs on the same room and typing in one shows up in the other.
- **Room routing is now live:** the landing page (`/`) lets you type a room ID to join, or click "Create New Room" to generate one, then navigates to `/room/[roomId]`. That `roomId` is used as the Yjs document/room name for both the `Y.Doc` and the `WebsocketProvider`, and `y-websocket`'s server-side `setupWSConnection` keys its in-memory document map by that same name — so each room ID gets its own independent document, and rooms never see each other's edits.
- The env var `NEXT_PUBLIC_WS_URL` (see `collab-code-editor/.env.example`) controls which server the provider connects to — defaults to `ws://localhost:8080` locally, and should point at the deployed Railway/Render URL in production.
- A small connected/connecting/disconnected status dot in the editor toolbar reflects the provider's live connection state (replaces the old temporary debug panel, which has been removed now that real sync is in place).

---

## Local Setup / Installation

```bash
git clone [repo-url]
cd collab-code-editor
npm install

# Start the self-hosted Piston sandbox (code execution engine)
docker compose up -d

# Run the frontend
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), write some code in the editor, pick a language, and hit **Run** — it's forwarded to `/api/execute`, which relays it to the local Piston container and streams back stdout/stderr/exit code.

By default the app talks to Piston at `http://localhost:2000`. Override with a `PISTON_API_URL` env var if you're running Piston elsewhere.

### WebSocket server (Yjs sync)

A standalone WebSocket server lives in `server/`, sibling to `collab-code-editor/`. It now speaks the **Yjs sync protocol** — via `y-websocket`'s server-side `setupWSConnection` utility (`server/yjsConnection.js`) — instead of the plain echo logic from the earlier scaffold. To run it locally:

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

It listens on `PORT` from `.env` (default `8080`). Run it alongside the frontend (`npm run dev` in `collab-code-editor/`, pointed at it via `NEXT_PUBLIC_WS_URL`) to see edits sync live between browser tabs.

*Postgres and Redis aren't wired up yet — setup instructions for those will be added as each comes online.*

---

## Roadmap / What's Next

- [x] Basic single-user code editor UI (Monaco)
- [x] Code execution via Piston integration (self-hosted via Docker)
- [x] Real-time multi-tab sync (Yjs + `y-websocket` + WebSocket server)
- [x] Room routing (`/room/[roomId]`, joined/created from a landing screen)
- [ ] Presence indicators and live cursor labels
- [ ] Room persistence with Postgres
- [ ] Reconnect/resync handling
- [ ] Execution resource limits + worker queue
- [ ] Redis pub/sub for horizontal scaling
- [ ] Deploy live demo (Vercel + Railway/Render)

---

## License

MIT License. See `LICENSE` file for details.
