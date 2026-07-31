# Rate limiting, payload size, and the snapshot write queue

The three limiters: two endpoints and one that sits between a destroyed room and its INSERT.

*Split out of `CLAUDE.md` on 2026-07-31. Same rules apply: this is the **why** — measurements,
rejected alternatives, debugging history. The code carries the rule, this carries the rationale,
and a change that contradicts a paragraph here rewrites it rather than appending a correction.*

## Rate limiting and payload size

Both endpoints that cost real resources are limited to **10 requests/minute/IP**:
`POST /rooms` on the sync server and `POST /api/execute` on the frontend. The limiter is an
in-memory sliding window, duplicated once per workspace (`server/src/http/rateLimit.js`,
`web/src/lib/sandbox/rateLimit.ts`) — the two workspaces share no code, the same reason
`CLOSE_ROOM_NOT_FOUND` exists twice.

**The frontend limiter is honestly approximate and the code says so.** No Redis and no
database is a v1 constraint, not an oversight, so there is no shared counter: on Vercel each
serverless instance keeps its own, and a caller spread across N warm instances gets up to N
times the nominal limit. It converts an unbounded flood into a bounded one; it is not a
security boundary.

**An earlier version of this paragraph ended "The sync-server side *is* exact — one Railway process,
one counter." That was false as written,** and the audit demonstrated it: the counter was exact per
*key*, and `clientKey` read the **left-most** `x-forwarded-for` entry — the one value a caller fully
controls. Twelve requests with a rotating forged prefix all succeeded. Worse, that same key becomes
the room's `creatorKey` and then the snapshot queue's pacing key, so a forged header also sidestepped
`MAX_QUEUED_PER_KEY` and `SNAPSHOT_WRITE_LIMIT`.

Both copies now read **right-most minus (hops − 1)**, via `TRUSTED_PROXY_HOPS` (default 1), which is
correct whether the platform appends to the header or overwrites it — left-most is correct under
neither. An over-count clamps to the left-most, i.e. degrades to the old behaviour rather than to a
wrong bucket. Junk that is not an IP literal never becomes a key, and a port is stripped so one
client is not many keys. With that in place the two framings are legitimately different, and each
comment says its own thing rather than sharing one hedge:

- **sync server:** one process, one counter, and a key the caller can no longer choose. `POST /rooms`
  is a real per-address bound.
- **frontend:** still approximate, for a reason that has nothing to do with XFF — there is no shared
  counter across serverless instances.

`DRIFT-15a` runs one deterministic key/time sequence through both limiters and asserts the verdict
streams are identical arrays, which is the only mechanism that catches a one-sided edit.

**This is a different thing from `MAX_RESERVATIONS`.** That is a global ceiling on unclaimed
rooms with no notion of who created them; this bounds a single caller. Both are needed: the
limiter stops one script exhausting the ceiling, the ceiling stops many callers doing it.
`MAX_RESERVATIONS = 1000` is a **deliberate non-env constant** — it bounds memory, not a caller, and
`LC-05` is the only test that can reach it (it fills the ceiling, so it lives in its own file:
reservations sit in module state behind a 5-minute unref'd timer with nothing exported to clear
them, and a filled ceiling makes `reserveRoom` return null, which would silently make every later
test in the same file assert against a room id of `null`).

**`POST /rooms`' own limit is env-overridable since the audit** — `ROOM_CREATE_LIMIT` /
`ROOM_CREATE_WINDOW_MS`, default unchanged at 10 per 60s. Not a product requirement: an end-to-end
suite legitimately creates ~20 rooms in two minutes, and the symptom of tripping the default is a
room-creation timeout deep inside an unrelated spec, indistinguishable from a product bug.

### The snapshot write queue (task 7.5)

There is a **third** limiter, and it is not an endpoint: `server/src/storage/snapshotQueue.js` sits between
`destroyRoom()` and `db.saveDeadRoom()`. It is what the guardrails spec's "rate-limit DB writes the
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
exact check runs afterwards, on the decoded `code` **plus `stdin`** (§10.4 made it one combined
budget — see "Shared code execution"), and is the one that enforces the cap. Both use UTF-8 byte
length, not `String.length`: a document of emoji or CJK is up to 4x its character count on the
wire, and the wire size is what is being capped.

`web/src/hooks/useCodeRunner.ts` calls the same `payloadTooLarge()` from `web/src/lib/sandbox/execution.ts` before fetching. That
is a courtesy, not the enforcement — the route is reachable without the UI — but it means an
oversized document never crosses the wire, and it writes the failure into the shared
`execution` map like any other result, since the document is shared and so is the problem.

