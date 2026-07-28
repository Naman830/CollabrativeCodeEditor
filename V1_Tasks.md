# CollabCode — Real-time Collaborative Code Editor

A lightweight, no-database collaborative code editor. Users create or join a room, edit code together in real time, run it via Piston, and save the file locally. Rooms are ephemeral — they exist only in server memory and die the moment everyone disconnects.

## Tech stack

- **Frontend**: Next.js (Vercel)
- **Backend**: Node.js + WebSocket server (Railway)
- **Real-time sync (CRDT)**: Yjs
- **Code execution**: Piston API, self-hosted via Docker
- **Persistence**: None — no database, no Redis. All room state lives in server memory for the lifetime of the room.

## Core principles

- No accounts, no login, no database.
- A room is just an in-memory Yjs document keyed by a random, unguessable ID.
- Saving a file means downloading it to the user's device — nothing is stored server-side.
- When the last person leaves a room, the room and its contents are destroyed (after a short grace period so a page refresh doesn't count as leaving).

---

## Feature checklist

### 1. Landing / home page
- [x] Simple hero with two primary actions: **Create a Room** / **Join a Room**
- [x] "Create a Room" flow:
  - [x] Prompt for first name + last name (no accounts)
  - [x] Generate a cryptographically random room ID (`crypto.randomUUID()`, minted by the server via `POST /rooms` so that an ID the server never handed out can be refused at connect time)
  - [x] Assign the user a random color (used later for cursor/presence)
  - [x] Redirect to `/room/<id>`
- [x] "Join a Room" flow:
  - [x] Input field for room ID, OR
  - [x] Deep link support: pasting/opening a room URL joins directly (`/room/<id>`)
  - [x] Prompt for first name + last name + assign random color on join too

### 2. Room / editor page
- [x] Top user bar: shows connected users' short names/initials, each tagged with their assigned color (duplicate short names numbered, e.g. "Naman S1"/"Naman S2"; duplicate colors reassigned to a free palette entry, both resolved per room)
- [x] Code editor pane (e.g. Monaco or CodeMirror) wired to Yjs for CRDT sync
- [x] Language selector dropdown (drives both editor syntax highlighting and Piston execution)
- [x] Live multiplayer cursors: each user's cursor/selection shown in their assigned color
- [x] Output panel: displays stdout/stderr from Piston after running code
- [x] "Run" button: sends current code + selected language to backend → Piston → streams result to output panel for **everyone in the room**
- [x] "Save" button: downloads the current file to the user's device with correct extension (`.py`, `.cpp`, `.ts`, etc. based on selected language)
- [x] Room becomes inaccessible / redirects home if the room ID doesn't exist (e.g. it already closed): the room is checked over HTTP before the editor mounts, so no WebSocket is opened for a dead room, and the server itself refuses connections to unknown rooms. A closed room shows "This room has closed" and redirects home after 3s; a sync server that can't be reached is reported separately, with a Retry, so it is never mistaken for a closed room.

### 3. Real-time collaboration (Yjs)
- [x] Yjs document created in-memory per room on the server
- [x] WebSocket provider connecting client editor to the Yjs doc
- [x] Awareness protocol wired up for:
  - [x] Live cursor positions
  - [x] Live selections
  - [x] Presence (who's currently in the room)
- [x] Conflict-free concurrent editing verified with 2+ simultaneous typers

### 4. Room lifecycle management
- [x] Server maintains an in-memory `Map<roomId, { yjsDoc, users }>` (`server/rooms.js`, over y-websocket's `docs` map)
- [x] On last user disconnect: destroy the Yjs doc and remove the room from the map — **debounced**, 10s by default (`ROOM_GRACE_MS`), so the last person in a room can refresh without deleting it out from under themselves
- [x] No write to disk, no external persistence at any point

### 5. Code execution (Piston)
- [x] Dockerized Piston instance running alongside/near the Node server
- [x] Backend endpoint that accepts `{ language, code }` and forwards to Piston
- [x] Handle and surface Piston errors (timeouts, unsupported language, runtime errors) cleanly in the output panel
- [x] Reasonable execution timeout to prevent runaway/blocking processes: sandbox-side limits sent with every request and capped in `docker-compose.yml` — 5s run (wall *and* CPU, since a busy loop burns both), 10s compile, 256 MB run memory, 512 MB compile memory. A killed program gets a plain-English notice instead of a raw sandbox signal

### 6. Notifications / activity feed (extra, in-room)
- [x] Toast or subtle banner: "X joined the room" (with a join sound effect)
- [x] Toast or subtle banner: "X left the room" (with a leave sound effect)

### 7. Security / abuse prevention
- [x] Room IDs long and random enough to be unguessable (no sequential/short IDs)
- [x] Basic rate limiting on room creation and code execution endpoints: 10/minute/IP on both `POST /rooms` and `POST /api/execute`, via an in-memory sliding window (no Redis — out of scope). Exact on the sync server (one process); best-effort per instance on Vercel
- [x] Sane payload size limits on code sent to Piston: 64 KB of code, checked cheaply against `Content-Length` before the body is read and exactly on the decoded program afterwards. The client checks the same shared constant so an oversized document never reaches the wire

---

## Explicitly out of scope for v1

- User accounts, authentication, or login
- Any database or Redis
- Server-side file storage or persistence of any kind
- Shareable short links / URL shortener (planned as a future addition)
- Horizontal scaling across multiple server instances

## Suggested build order

1. Next.js scaffold + basic routing (`/`, `/room/[id]`)
2. WebSocket server on Node + in-memory room map
3. Yjs wiring: doc creation, provider, awareness (cursors/presence)
4. Editor UI (Monaco/CodeMirror) bound to Yjs
5. User bar + join/leave notifications
6. Piston integration (Docker) + Run button + output panel
7. Save-to-local functionality
8. Room lifecycle cleanup (destroy on last disconnect)
9. Polish: colors, language selector, rate limiting, error states

---

*Instructions for Claude Code: use the checklist above to generate a task list, implement features in the suggested build order, and check off each item as completed. Do not introduce a database, Redis, or authentication — this project is intentionally kept simple and stateless.*
