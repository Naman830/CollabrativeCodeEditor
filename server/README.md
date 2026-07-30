# WebSocket Server

A standalone Node.js server that powers real-time collaboration for the code editor. It speaks the **Yjs sync protocol** (via `y-websocket`'s server-side `setupWSConnection` utility, in `server/src/sync/connection.js`) rather than a custom message format — the room/document name comes straight from the URL path (e.g. `ws://host:port/<roomId>`).

What it owns is **room lifetime**: rooms are minted here and destroyed here. Live documents are
in-memory only — nothing about a running room is persisted. The two things it does reach outside
itself for are both optional and both fail soft: it verifies a Clerk token off the socket query
string to record who was in a room, and when a room dies it writes one read-only snapshot to
Postgres. Unset `CLERK_SECRET_KEY` or `DATABASE_URL` and the server behaves exactly as it did in
v1 — no members recorded, nothing written, rooms served normally.

## Layout

```
src/
├── index.js                 one listener: the HTTP routes below + the WS upgrade
├── sync/connection.js       the only place that speaks the Yjs wire protocol
├── rooms/lifecycle.js       ⭐ the one authority on whether a room exists
├── rooms/state.js           what a room *was*: members, language, snapshot building
├── storage/db.js            one pg pool, one INSERT, no ORM
├── storage/snapshotQueue.js when a snapshot is actually written (pacing + drain)
├── auth/clerk.js            the one place a token becomes a user ID
└── http/rateLimit.js        in-memory sliding window
```

The folder carries the domain and the file carries the role — hence `rooms/lifecycle.js` rather
than `rooms/rooms.js`. Dependencies run one way only: `index → sync → rooms → storage`.

## Room lifetime (`server/src/rooms/lifecycle.js`)

```
reserved ──connect──► live ──last socket closes──► grace (10s) ──► destroyed
   │                    ▲                             │
   └─5 min, unclaimed───┘  reconnect cancels ─────────┘
```

A connection to a room that is in none of those stages is **refused**: the socket is accepted and then closed with code `4404` / `room-not-found`. This has to happen on the server, because `setupWSConnection` creates the doc on first connect — a client-side check alone would be undone by the very socket it was guarding.

`y-websocket` only deletes docs from its `docs` map when a persistence layer is configured, and this server deliberately has none, so `server/src/rooms/lifecycle.js` owns that deletion instead.

## HTTP routes

Served on the same `PORT` as the WebSocket upgrade. All responses send `Access-Control-Allow-Origin: *` — the frontend is always a different origin.

| Route | Purpose |
| --- | --- |
| `POST /rooms?language=<lang>` | Reserve a new room; returns `201 {"roomId":"<uuid>","language":"<lang>"}`, or `429` at the reservation ceiling / rate limit. The language rides in the **query string, not a body** — a body would mean a `Content-Type`, i.e. a CORS preflight before every room creation. |
| `GET /rooms/:id` | `200 {"exists":true\|false,"language":...}` — "is this room live right now", not "has anyone ever visited it". **Always 200**; a dead room is `exists: false`, never a 404, because the client needs "missing" and "unreachable" to look different. |
| `GET /health` | `200 {"ok":true}`, or `503` while draining at shutdown. Also how the frontend tells "sync server down" apart from "room closed". |

## Running locally

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

## Environment

Full descriptions live in `.env.example`; this is the shape of it.

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port for both the WebSocket upgrade and the HTTP routes above. |
| `ROOM_GRACE_MS` | `10000` | How long an emptied room lingers before destruction. Non-zero so the last person in a room can refresh without deleting it out from under themselves. |
| `ROOM_RESERVATION_MS` | `300000` | How long a created-but-never-entered room stays claimable. |
| `CLERK_SECRET_KEY` | — | **Optional.** Verifies the socket's `?token=`. Unset, no room has members. Must be the same Clerk instance as the frontend's publishable key. |
| `DATABASE_URL` | — | **Optional.** Neon's *pooled* string. Unset, no pool opens and the snapshot write is a logged no-op. |
| `MEMBER_MIN_CONNECTED_MS` | `60000` | How long a signed-in participant must stay before they can earn a snapshot. Only half the rule — they must also have edited. |
| `SNAPSHOT_FLUSH_MS` | `20000` | Ceiling on how long shutdown waits for queued snapshot writes to drain. |
| `SNAPSHOT_WRITE_LIMIT` / `SNAPSHOT_WRITE_WINDOW_MS` | `60` / `60000` | Snapshot write pacing, keyed on the room creator's IP. Over-limit writes **wait**; they are never dropped. |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | Per-attempt Postgres connect timeout. Must sit under `SNAPSHOT_FLUSH_MS` and over a Neon cold start. |

## Troubleshooting: "Couldn't reach the sync server"

That banner does **not** mean the server is down. `checkRoom()`/`createRoom()` in
`web/src/lib/collab/rooms.ts` catch *any* `fetch` rejection and report
`unreachable`, so a DNS block, a captive portal and a genuinely dead server all look
identical from the browser. Prove which it is with a request that skips DNS entirely:

```bash
# IP from a resolver you trust: nslookup <sync-host> 1.1.1.1
curl -s --resolve <sync-host>:443:<that-ip> https://<sync-host>/health
```

`{"ok":true}` means the server is healthy and the problem is your own network's DNS.
Some mobile-carrier resolvers answer `REFUSED` for a whole delegated hosting zone
(`up.railway.app`, say) while resolving the parent domain normally — a phone hotspot is the
usual culprit, and it is indistinguishable from a dead deployment in the browser. Fix it by
pinning a public resolver on that connection rather than chasing the deployment:

```bash
sudo nmcli con mod "<wifi name>" ipv4.dns "1.1.1.1 8.8.8.8" ipv4.ignore-auto-dns yes
sudo nmcli con up "<wifi name>"
getent hosts <sync-host>   # now returns an address
```

Running everything locally, this banner almost always just means the sync server on `:8080`
is not started.
