# WebSocket Server

A standalone Node.js server that powers real-time collaboration for the code editor. It speaks the **Yjs sync protocol** (via `y-websocket`'s server-side `setupWSConnection` utility, in `yjsConnection.js`) rather than a custom message format — the room/document name comes straight from the URL path (e.g. `ws://host:port/<roomId>`).

There is no persistence and no auth. What it *does* own is **room lifetime**: rooms are minted here, and destroyed here.

## Room lifetime (`rooms.js`)

```
reserved ──connect──► live ──last socket closes──► grace (10s) ──► destroyed
   │                    ▲                             │
   └─5 min, unclaimed───┘  reconnect cancels ─────────┘
```

A connection to a room that is in none of those stages is **refused**: the socket is accepted and then closed with code `4404` / `room-not-found`. This has to happen on the server, because `setupWSConnection` creates the doc on first connect — a client-side check alone would be undone by the very socket it was guarding.

`y-websocket` only deletes docs from its `docs` map when a persistence layer is configured, and this server deliberately has none, so `rooms.js` owns that deletion instead.

## HTTP routes

Served on the same `PORT` as the WebSocket upgrade. All responses send `Access-Control-Allow-Origin: *` — the frontend is always a different origin.

| Route | Purpose |
| --- | --- |
| `POST /rooms` | Reserve a new room; returns `201 {"roomId":"<uuid>"}`, or `429` at the reservation ceiling. Send **no body** — that keeps it a CORS simple request, so there is no preflight. |
| `GET /rooms/:id` | `200 {"exists":true\|false}` — "is this room live right now", not "has anyone ever visited it". |
| `GET /health` | `200 {"ok":true}`. Also how the frontend tells "sync server down" apart from "room closed". |

## Running locally

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port for both the WebSocket upgrade and the HTTP routes above. |
| `ROOM_GRACE_MS` | `10000` | How long an emptied room lingers before destruction. Non-zero so the last person in a room can refresh without deleting it out from under themselves. |
| `ROOM_RESERVATION_MS` | `300000` | How long a created-but-never-entered room stays claimable. |
