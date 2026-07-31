# Dead-room snapshots and Postgres

What is written when a room dies, for whom, and the database that receives it.

*Split out of `CLAUDE.md` on 2026-07-31. Same rules apply: this is the **why** — measurements,
rejected alternatives, debugging history. The code carries the rule, this carries the rationale,
and a change that contradicts a paragraph here rewrites it rather than appending a correction.*

## Dead-room snapshots (task 7.3)

When a room is destroyed, its final text is written **once** to `dead_rooms`, plus one
`dead_room_members` row per person who earned a copy. `server/src/rooms/lifecycle.js`'s `destroyRoom()` is
the single site; `server/src/rooms/state.js` decides what and for whom. Guest-only rooms — still the
common case — write nothing at all, exactly as in v1.

**Since 7.5, "taken" and "written" are two different moments.** `destroyRoom()` still captures
the room's final state at the instant it dies, and is still the only place that does — but it
then hands the snapshot to `server/src/storage/snapshotQueue.js`, which decides when the INSERT actually
runs. Everything below about *what* is captured and *for whom* is unchanged; what moved is the
timing. Two consequences worth carrying into any change here: the snapshot carries its own
`diedAt` rather than letting the INSERT default to `now()`, and `db.saveDeadRoom()` must not be
called from anywhere but the queue, or the concurrency cap stops meaning anything. See "The
snapshot write queue" under "Rate limiting and payload size".

**Who a dead room belongs to.** Every verified signed-in participant who **stayed 60s**
(`MEMBER_MIN_CONNECTED_MS`) **and actually edited the document**. There is no owner and no
ownership transfer. The two halves do different jobs and neither is redundant: the timer stops
a drive-by, and **the edit check is the only thing that stops a lurker**, since anyone who
leaves a tab open passes 60s. The spec originally said "connected while the document was
non-empty" instead — that is unimplementable here, because `useCollabRoom` seeds the starter file
on `sync`, so every room is non-empty milliseconds after the *first* client arrives and the
clause filters nothing.

**Yjs hands you the WebSocket as the transaction origin, and that is what makes "did they
edit" cheap.** y-websocket's `messageListener` calls
`syncProtocol.readSyncMessage(decoder, encoder, doc, conn)` — the 4th argument is the origin —
so `doc.on("update", (_u, origin) => …)` identifies the sending socket, and a `conn -> userId`
map turns it into attribution. Use `doc.on("update")` rather than a `Y.Text` observer: `Doc.destroy`
calls `super.destroy()`, which removes the Doc's own observers, while a `Y.Text` handler
survives destruction — and the origin is only available on the Doc event anyway.

**Verification is asynchronous, so early edits arrive unattributed. This silently lost
snapshots.** The first `verifyToken` of a process fetches Clerk's JWKS (~200ms measured; ~1ms
once cached), while a client syncs and starts typing in ~50ms. Every edit in that window found
no entry in `connUsers`, so `didEdit` stayed false and the user failed the threshold. It
reproduced **consistently for the first signed-in user after every restart** and vanished for
everyone afterwards, which makes it look like flakiness rather than a bug. `rooms/state.js`
therefore keeps a `pendingEdits` set of sockets that edited before their token resolved, and
`beginMemberSession` drains it. `forgetConn` clears it for *every* closing socket, verified or
not, because a guest's entry would otherwise sit there for the room's whole life.

**`doc.destroy()` synchronously re-fires the awareness `update` handler one last time.**
`y-protocols` registers `doc.on('destroy', () => this.destroy())`, and `Awareness.destroy()`
calls `setLocalState(null)` — which emits `update` — **before** `super.destroy()` drops
listeners. Two consequences: every handler in `rooms/state.js` is **lookup-only** and bails on a
missing room (a get-or-create there resurrects state for a room that was just destroyed, and
nothing would ever delete it again), and `deleteRoomState()` runs **after** `doc.destroy()`,
never before.

**Awareness is already empty when a room dies, so `participants` must be accumulated.**
y-websocket's `closeConn` calls `removeAwarenessStates()` for every socket that closes, so by
eviction time `getStates()` returns nothing. There is no later moment at which "who was here"
is recoverable. The accumulator dedupes on **`name|color`, never `clientID`** — a refresh
inside the grace window mints a new `Y.Doc` and therefore a new clientID, so one person who
refreshed twice would appear three times. It also walks only the `{added, updated}` clientIDs
the event carries: awareness `update` fires on *every cursor move of every peer*, so a full
`getStates()` rescan would re-walk the participants map on every keystroke in the room.

**Two tabs are two collaborators but one member.** The client-side sessionStorage split (see
"Identity storage is split on purpose") deliberately makes a second tab a separate
collaborator with its own cursor and colour; server-side, both sockets verify to the same Clerk
ID and reference-count into one member. Seeing two chips in the user bar and one
`dead_room_members` row is correct, not a bug.

**The member refcount has three ways to corrupt itself, and each loses data silently.**
`sessionStartedAt` is set only on the 0→1 transition (otherwise a second tab opening at t=90s
resets the clock); it uses `Math.min` because verification resolves *out of socket order* —
the first connection pays the JWKS round trip and later ones hit the cache, so a socket opened
at t=0 can register after one opened at t=100ms; and `endMemberSession` must run at most once
per socket, guarded by an `ended` flag at the call site rather than `Math.max(0, …)`, which
would hide a negative count while still stranding that user's time for the room's life.

**Never read `connectedMs` directly — go through `elapsedMs(member, now)`.** At the SIGTERM
flush every member is still connected, so `connectedMs` is missing the entire live session.
Reading it raw fails every member on every deploy — precisely the case the flush exists for.

**The shutdown flush destroys live rooms too, and that is the point.** Documents are in-memory
only and the registry dies with the process, so at SIGTERM a live room *is* a dead room that
has not noticed. Flushing only rooms already inside their grace window would save the rooms
nobody was using and lose every room someone was working in, on every deploy. Shutdown closes
sockets with **1012 (Service Restart), not 4404** — the client treats 4404 as permanent and
stops retrying, which is exactly wrong for a redeploy — and `/health` answers 503 while
draining so Railway stops routing.

**That 503 was unreachable until the audit, and an earlier version of this paragraph stated it as
fact.** `shutdown()` called `server.close()` *before* `flushAndDestroyAll()` set the flag, so by the
time `/health` would have answered 503 the listener was already refusing connections and the
platform saw `ECONNREFUSED` instead. The flag is now set first, by `beginShutdown()`, and
`server.close()` runs last. One consequence had to land in the same change: because the listener
now stays open through the flush, **`POST /rooms` must refuse with 503 too** — `flushAndDestroyAll`
iterates `docs` and never `reservations`, so a room minted mid-drain would never be flushed and its
creator would meet "this room has closed" after the restart.

Since 7.5 the flush also calls `snapshotQueue.releasePacing()`
**before** the destroy loop and `snapshotQueue.destroy()` after the deadline race; both are
explained under "The snapshot write queue", and without the first a queue with no live rooms
behind it is lost outright.

**`destroyRoom` must not be `async`, and nothing may be awaited before `docs.delete()`.** An
await there leaves a window in which `roomExists()` still answers true, so a client can
reconnect into a room whose snapshot is already committed — a live room whose `room_id` is
burned by the `UNIQUE` constraint, meaning its real snapshot is later swallowed by
`ON CONFLICT DO NOTHING`. That same synchronous `docs.delete()` is what makes the function
idempotent against the eviction timer racing the flush.

**Destruction is unconditional; snapshotting is best-effort.** An uncaught throw inside the
eviction `setTimeout` is an uncaught exception that kills the process and every other live
room. Snapshot building is wrapped in `try/catch`, and `doc.destroy()` + `deleteRoomState()`
sit in a `finally`.

**Two ways the snapshot text can silently poison the INSERT.** A **NUL byte** (`\u0000`) cannot be stored in a
Postgres `text` or `jsonb` value at all — Monaco will not type one but a paste can carry it —
so it is stripped. And truncation must go through `Buffer.subarray(...).toString("utf8")`,
never a byte index into the JS string: a hand-rolled slice can cut a surrogate pair in half,
`JSON.stringify` then emits a lone `"\ud83d"`, and Postgres rejects the whole statement with
`unsupported Unicode escape sequence`. Node's decoder substitutes `U+FFFD` instead. Only
reachable with emoji or CJK near the 256 KB cap — i.e. never by accident in testing.

**`pool.query("BEGIN")` is not a transaction.** With `max: 3` the BEGIN, the INSERTs and the
COMMIT can each land on a *different* pooled connection, so the inserts run outside the
transaction and the COMMIT commits nothing. It fails silently, because the rows still appear.
`saveDeadRoom` checks out a client with `pool.connect()`, and `client.release()` in a `finally`
is mandatory — a leaked client out of a pool of three blocks the next two snapshots for
`connectionTimeoutMillis` and then fails them.

**Read `RETURNING id`, not `rowCount`.** With `ON CONFLICT DO NOTHING` a conflict yields an
empty `rows` array, and the id is what the members insert needs anyway. On a conflict the
members are deliberately **not** topped up: the first write is authoritative and a snapshot is
never updated (§6.1).

**`DB_CONNECT_TIMEOUT_MS` has to cover a Neon cold start, not just a TLS handshake.** The pool
is always cold at SIGTERM (the process is idle between evictions, `idleTimeoutMillis` is 30s)
and Neon autosuspends an idle branch. Measured ~750–900ms warm, but **over 5s against a
suspended branch** — a 5s ceiling was observed failing outright with `Connection terminated due
to connection timeout`. Hence 10s, under a 20s flush budget.

**`jsonb` does not preserve object key order.** It normalises to shortest-key-first, so
`{filename, content}` reads back as `{content, filename}`. Harmless, but any test comparing
serialised JSON must compare structurally instead.

**Nothing that reaches a column may carry a NUL or an unpaired surrogate.** NUL cannot be
stored in `text` or `jsonb` at all; a lone surrogate is worse, because it fails late and
loudly — `JSON.stringify` happily emits a bare `\ud83d`, and Postgres rejects the **whole**
statement with `unsupported Unicode escape sequence`, so one bad character in one
participant's name loses the room's code too. Both are stripped by `stripUnstorable` in
`server/src/rooms/state.js`, applied to every path. Two traps this closed, both found in 7.4:
`sanitizeName`'s cut counted UTF-16 code units and could halve a surrogate pair — the name cut
is now by **code point**; and `snapshotText` only repaired the document on its *truncating*
branch, where `Buffer.toString("utf8")` substitutes U+FFFD, so a lone surrogate in a document
**under** 256 KB was returned untouched. Monaco types neither character, but awareness is
peer-supplied and a paste or a raw Yjs client can carry both.

## Persistence (Postgres)

**Postgres is the only data store, and it holds exactly one thing**: the `dead_rooms` snapshot
written when a room is destroyed. Nothing on the live path touches it — sync stays in memory,
Save stays local, and the rate limiters stay in-process. Adding Postgres does **not** make a
shared rate-limit counter a candidate: a per-request round trip on the execute path is a worse
trade than the documented per-instance approximation.

The database is **Neon** (`neondb`, `ap-southeast-1`), with a `dev` branch
(`ep-raspy-rice-aosriqt9`) for local work and `main` (`ep-super-star-ao4pfz3z`) for the
deployed site, so local testing never writes rows the deployed `/profile` would read. Both
carry the same single migration. `web/.env.local` and `server/.env` point at
`dev`; Railway and Vercel must point at `main`.

**The Neon database was not empty when 7.2 migrated it, and this is worth knowing before you
trust anything in it.** It held a `Room` table (42 rows of `ydocState bytea`) and a
`_prisma_migrations` row `20260706083131_init` from an abandoned experiment that persisted live
Yjs documents to Postgres — precisely what the out-of-scope list rules out. Those commits are dangling,
reachable from no branch, so nothing in the repo explained the tables. Both were dumped to a
backup and dropped, so `dead_rooms` now has a single migration history that replays cleanly
from an empty database. If a future `prisma migrate` reports drift, check for leftovers like
these before assuming the schema is wrong.

**Create the Neon branch *before* diverging the two databases, not after.** A branch is a
copy-on-write fork of the parent at the moment it is taken — and this bit during 7.2: `dev`
was cut from a snapshot of `main` that predated the cleanup, so it arrived carrying the same
42-row `Room` table and stale migration row, and had to be dropped and migrated a second time.
A branch does not track its parent.

**The two connection strings are not interchangeable, and swapping them fails confusingly
rather than loudly.** `DATABASE_URL` is Neon's *pooled* endpoint (its host contains `-pooler`)
and is what the app and the sync server use at runtime — Vercel runs many short-lived
instances that would each open their own pool and exhaust the project's connection ceiling
within a few requests. `DIRECT_URL` is the *unpooled* endpoint and is used by `prisma migrate`
alone: the pooler runs pgbouncer in transaction mode, which cannot hold the session-level
advisory lock a migration takes, so migrations pointed at the pooled URL hang or fail
part-applied.

### Prisma 7 invalidates almost every Prisma recipe written before it

Three breaking changes, all of which bite at a different moment:

- **The generator is `prisma-client`, not `prisma-client-js`** (deprecated), and `output` is
  now **required**. The client is therefore imported from that generated path
  (`../../generated/prisma/client`), **not** from `@prisma/client`. Importing the package path
  compiles fine and yields a client with no models on it.
- **A driver adapter is required.** Prisma 7 removed `datasourceUrl` *and* `datasources` from
  the `PrismaClient` constructor, so there is no way to hand it a URL directly; the connection
  string goes through `new PrismaPg({ connectionString })` from `@prisma/adapter-pg`. This is
  caught at compile time (`'datasourceUrl' does not exist in type 'PrismaClientOptions'`),
  which is the one merciful failure of the three.
- **Prisma no longer auto-loads `.env`,** and the datasource URL moved out of `schema.prisma`
  into `prisma.config.ts`. `prisma.config.ts` calls `dotenv`'s `config({ path: ".env.local" })`
  itself — Next's convention is `.env.local`, Prisma's default is `.env`, and loading the
  former explicitly keeps one file instead of two. Without that call the CLI reports a missing
  datasource URL rather than a missing file.

**`prisma init` writes more than Prisma files.** Run in a project root it also drops
`.claude/skills/`, `.windsurf/skills/`, `.agents/skills/` and a `skills-lock.json` alongside
the schema, and appends to `.gitignore`. Scaffold in a scratch directory and copy across, or
it silently edits this repo's agent configuration.

**`prisma generate` must run before `next build`, and `postinstall` alone is not enough on
Vercel.** Vercel restores a cached `node_modules` and can skip `postinstall` entirely, which
produces a build failing on a missing generated client that works perfectly locally. The
`build` script is therefore `prisma generate && next build`, with `postinstall` kept as a
convenience for fresh local installs. `next.config.ts` needs nothing: `@prisma/client` is
already on Next 16's built-in `serverExternalPackages` list.

### The sync server does not use Prisma

`server/src/storage/db.js` is a plain `pg` pool and two hand-written INSERTs in one transaction. The sync
server writes one room's worth of rows in its entire life and never reads or updates one, so a
second `schema.prisma`, a `prisma generate` step, and the query engine in the Railway image
would all be overhead. This is the same deliberate duplication as `rateLimit.js` /
`rateLimit.ts`: **a column renamed in `schema.prisma` must be renamed in those statements by
hand — nothing checks it.** The only thing that catches a rename is running `saveDeadRoom()`
for real and reading both tables back, which is why that acceptance check exists.

**`server/src/rooms/state.js` is now the third instance of this cross-workspace duplication**, after
`rateLimit.js`/`rateLimit.ts` and `CLOSE_ROOM_NOT_FOUND`. It carries its own copies of
`sanitizeName` (from `web/src/lib/collab/user.ts`) and `HEX_COLOR` (from `web/src/lib/collab/awareness.ts`), because
`participants` is peer-supplied data that will be rendered on `/profile` and the server has no
way to import either. Since §10.1 it also carries `ROOM_LANGUAGES` (the `value` column of
`LANGUAGES` in `web/src/lib/editor/languages.ts`), the shared-document names, and a second copy of the
filename sanitizer — all for the same reason, since `files[].filename` is peer-supplied and lands
on `/profile` too. Keep the values in step by hand; the alternative — trusting awareness, or
trusting a filename a client put in a `Y.Map` — is a hole, not a simplification.

Two things there are load-bearing. `pool.on("error", …)` is mandatory, not defensive: an idle
connection dropped by Neon's pooler emits an `error` event on the pool, and unhandled that is
an uncaught exception which would kill the sync server — taking every live room with it —
because of a database it was not even using. And `DATABASE_URL` is **optional**: unset, no pool
is opened and `saveDeadRoom()` is a logged no-op, so the guest flow (which stores nothing and
is the whole of v1) never depends on database infrastructure it does not touch.

`ON CONFLICT (room_id) DO NOTHING` is what enforces the write-once rule against a
retry or a restart that re-evicts an already-saved room, and it only works because `room_id`
carries a `UNIQUE` constraint.

**The `id` column has no database default, and `server/src/storage/db.js` is the only reason that works.**
`@default(uuid())` in `schema.prisma` is a *Prisma-side* default: the generated
`migration.sql` says plainly `"id" UUID NOT NULL` with no `DEFAULT` clause, because Prisma
mints the UUID in its client. The sync server has no Prisma client, so its INSERT supplies
`gen_random_uuid()` itself. Drop that from the statement and every write fails on a null
`id` — and the schema will look innocent, since it does declare a default. Use
`@default(dbgenerated("gen_random_uuid()"))` instead if a database-level default is ever
wanted.

**Verify this pairing by running the INSERT, not by reading the DDL.** A `\d dead_rooms`
proves the table parses; it proves nothing about whether the hand-written statement still
matches it. The check that catches a rename is calling `saveDeadRoom()` for real and reading
the row back.

**Write `sslmode=verify-full` in the connection strings, not the `sslmode=require` Neon hands
you.** node-postgres currently treats `require`, `prefer` and `verify-ca` as aliases for
`verify-full`, and warns on every connection that pg v9 will switch them to libpq semantics —
under which `require` encrypts but **does not verify the certificate at all**. So the string
that looks safe today becomes a silent downgrade to an unauthenticated TLS session on a routine
`npm update`. `verify-full` pins the strong behaviour and removes the warning; verified working
against Neon. `server/src/storage/db.js` additionally passes `ssl: { rejectUnauthorized: true }`
explicitly, which survives that change regardless — the connection string is the part that
would rot. Neon also appends `&channel_binding=require`, which node-postgres ignores; it is
dropped from these strings rather than carried along as decoration.

**`verify-full` is the right string for the app and the wrong one for `psql`.** node-postgres
verifies against Node's bundled CA store, so the URL in `.env.local` needs nothing more. The
`psql` CLI instead looks for `~/.postgresql/root.crt` and refuses to connect at all
(`root certificate file … does not exist`) — for ad-hoc queries append
`&sslrootcert=system`. **Never put `sslrootcert=system` in an env file**: node-postgres reads
that value as a *filename* and will try to open a file called `system`.

### Two deliberate departures from the original schema spec

- **`room_id` is `UNIQUE`.** This makes the database enforce "written once, never updated"
  instead of trusting the writer, and it is what `ON CONFLICT (room_id) DO NOTHING` rests on.
  7.2 also shipped an index on `(owner_user_id, died_at DESC)` for the `/profile` query;
  **7.3's migration dropped both that index and the column**, because §6.1 replaced
  creator-owns with `dead_room_members`. That table's composite primary key
  `(user_id, dead_room_id)` — `user_id` leading, so one user's rows are contiguous — is now the
  index the profile listing uses, and the listing is a join.
- **`language` is nullable**, where §6 writes plain `text`. That was forced rather than
  stylistic: the language dropdown *was* a per-user editing preference kept deliberately off the
  shared `Y.Doc`, so the server had no language to record, and `NOT NULL` would have made 7.3
  unbuildable. **§10.1 has since moved the selector to room creation and every new row carries a
  real language** — the snapshot's files carry their real names too, so the old `main.txt`
  placeholder is gone. The column stays nullable for the rows written before it: no migration can
  invent a language for a room whose peers each had their own.

