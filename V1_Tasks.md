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
- When the last person leaves a room, the room and its contents are destroyed instantly.

---

## Feature checklist

### 1. Landing / home page
- [ ] Simple hero with two primary actions: **Create a Room** / **Join a Room**
- [ ] "Create a Room" flow:
  - [ ] Prompt for first name + last name (no accounts)
  - [ ] Generate a cryptographically random room ID (`crypto.randomUUID()` or `nanoid(12)+`)
  - [ ] Assign the user a random color (used later for cursor/presence)
  - [ ] Redirect to `/room/<id>`
- [ ] "Join a Room" flow:
  - [ ] Input field for room ID, OR
  - [ ] Deep link support: pasting/opening a room URL joins directly (`/room/<id>`)
  - [ ] Prompt for first name + last name + assign random color on join too

### 2. Room / editor page
- [ ] Top user bar: shows connected users' short names/initials, each tagged with their assigned color
- [ ] Code editor pane (e.g. Monaco or CodeMirror) wired to Yjs for CRDT sync
- [ ] Language selector dropdown (drives both editor syntax highlighting and Piston execution)
- [ ] Live multiplayer cursors: each user's cursor/selection shown in their assigned color
- [ ] Output panel: displays stdout/stderr from Piston after running code
- [ ] "Run" button: sends current code + selected language to backend → Piston → streams result to output panel for **everyone in the room**
- [ ] "Save" button: downloads the current file to the user's device with correct extension (`.py`, `.cpp`, `.ts`, etc. based on selected language)
- [ ] Room becomes inaccessible / redirects home if the room ID doesn't exist (e.g. it already closed)

### 3. Real-time collaboration (Yjs)
- [ ] Yjs document created in-memory per room on the server
- [ ] WebSocket provider connecting client editor to the Yjs doc
- [ ] Awareness protocol wired up for:
  - [ ] Live cursor positions
  - [ ] Live selections
  - [ ] Presence (who's currently in the room)
- [ ] Conflict-free concurrent editing verified with 2+ simultaneous typers

### 4. Room lifecycle management
- [ ] Server maintains an in-memory `Map<roomId, { yjsDoc, users }>`
- [ ] On last user disconnect: destroy the Yjs doc and remove the room from the map (instant, or a few-second debounce to survive page refresh — pick one)
- [ ] No write to disk, no external persistence at any point

### 5. Code execution (Piston)
- [ ] Dockerized Piston instance running alongside/near the Node server
- [ ] Backend endpoint that accepts `{ language, code }` and forwards to Piston
- [ ] Handle and surface Piston errors (timeouts, unsupported language, runtime errors) cleanly in the output panel
- [ ] Reasonable execution timeout to prevent runaway/blocking processes

### 6. Notifications / activity feed (extra, in-room)
- [ ] Toast or subtle banner: "X joined the room" (with a join sound effect)
- [ ] Toast or subtle banner: "X left the room" (with a leave sound effect)

### 7. Security / abuse prevention
- [ ] Room IDs long and random enough to be unguessable (no sequential/short IDs)
- [ ] Basic rate limiting on room creation and code execution endpoints
- [ ] Sane payload size limits on code sent to Piston

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
