// The sync server's only connection to Postgres.
//
// This process writes one row in a room's entire life — the snapshot taken when
// the room dies — and never reads or updates one. That is why there is no ORM
// here: `web/prisma/schema.prisma` is the authority on the
// table's shape, and this file hand-writes the single INSERT it implies. Adding
// Prisma would mean a second schema copy, a `prisma generate` step, and the
// query engine in a Railway image, all to serve one statement.
//
// The cost is the same deliberate duplication as rateLimit.js / rateLimit.ts:
// the two workspaces share no code, so a column renamed in schema.prisma must
// be renamed in the INSERT below. There is no build step that would catch it.
//
// The snapshot is *taken* at the single destroy site in rooms/lifecycle.js (task 7.3) and
// *written* here, by snapshotQueue.js (task 7.5). Those used to be the same
// moment and no longer are — see "Rate limiting and payload size" in CLAUDE.md.
// Nothing else may call saveDeadRoom: the queue is what bounds how many of these
// run at once, and a caller that goes around it reintroduces the pool exhaustion
// that queue exists to prevent.

const { Pool } = require("pg");

// The pool ceiling, exported because snapshotQueue.js caps its concurrency at
// exactly this number: every worker then checks out a client immediately and
// none ever waits in pg-pool's pending queue, where `connectionTimeoutMillis`
// would eventually reject it. One constant, used in the Pool literal below and
// read by the queue, so the two cannot drift.
//
// If anything in this process ever uses the pool for something *other* than a
// snapshot, this stops being the right cap for the queue and it must drop below
// POOL_MAX — otherwise the two consumers race for the same three clients.
const POOL_MAX = 3;

// Optional on purpose. Every other local-dev path in this repo runs without its
// remote dependency (Piston down just fails a Run), and requiring a database to
// start the sync server would make the guest flow — which stores nothing and is
// the whole of v1 — depend on infrastructure it never touches.
const CONNECTION_STRING = process.env.DATABASE_URL;

/** @type {import("pg").Pool | null} */
let pool = null;

if (CONNECTION_STRING) {
  pool = new Pool({
    connectionString: CONNECTION_STRING,
    // One writer, one statement per dead room. A large pool would just hold
    // Neon connections open for a process that is idle between evictions.
    max: POOL_MAX,
    // A snapshot is not worth blocking shutdown over. If the database is
    // unreachable the write fails fast and the room is destroyed anyway.
    //
    // This must stay comfortably *below* the shutdown flush deadline in
    // rooms/lifecycle.js, and comfortably *above* a Neon cold start. Both edges are real:
    // the pool is always cold at SIGTERM (this process is idle between evictions
    // and idleTimeoutMillis is 30s), and Neon autosuspends an idle branch, so the
    // flush's first act can be waking a database as well as a TLS handshake.
    //
    // Measured: ~750-900ms against a warm branch, but >5s against a suspended
    // one — a 5s ceiling was observed failing outright with "Connection
    // terminated due to connection timeout". Since the flush deadline is a
    // ceiling that resolves as soon as the writes land, a generous value here
    // costs nothing on a healthy shutdown and is the difference between saving
    // and losing every snapshot on a deploy that follows an idle period.
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10_000,
    idleTimeoutMillis: 30_000,
    // Neon requires TLS. `sslmode=require` in the URL covers this, but callers
    // paste connection strings by hand and node-postgres silently downgrades to
    // a plaintext attempt without it, which Neon then rejects with a message
    // about the endpoint ID rather than about TLS.
    ssl: { rejectUnauthorized: true },
  });

  // An idle connection dropped by Neon's pooler emits an 'error' on the pool.
  // Unhandled, that is an uncaught exception — the sync server would die, every
  // live room with it, because a database it was not using went away.
  pool.on("error", (err) => {
    console.error("Postgres pool error (ignored, rooms are unaffected):", err.message);
  });
}

/** True when a DATABASE_URL was configured. Callers use this to skip work. */
function isEnabled() {
  return pool !== null;
}

/**
 * Writes one dead-room snapshot plus one `dead_room_members` row per qualifying
 * user, in a single transaction. Called exactly once per room, by
 * `server/src/storage/snapshotQueue.js` — never directly from the destroy site, which since 7.5
 * only *takes* the snapshot and hands it over.
 *
 * There is deliberately no owner: tasks.md §6.1 gives a copy to *every* verified
 * signed-in participant who met the contribution threshold. `userIds` is that
 * set, and every ID in it came from a Clerk token this server verified — never
 * from awareness (see auth/clerk.js).
 *
 * Never throws and never rejects: a failed snapshot must not stop a room being
 * destroyed, and there is nobody left in the room to report an error to. That
 * contract is load-bearing for `server/src/storage/snapshotQueue.js`, whose worker chain would
 * otherwise turn a `pool.connect()` rejection into an unhandled rejection —
 * fatal under Node's default `--unhandled-rejections=throw`, taking every live
 * room with it. `pool.connect()` is therefore *inside* the try: it rejects on
 * three separate paths (pool already ended, `timeout exceeded when trying to
 * connect`, and the `Connection terminated due to connection timeout` this repo
 * has actually observed against a suspended Neon branch).
 *
 * ON CONFLICT DO NOTHING enforces the write-once rule against retries and
 * against a server restart that re-evicts a room ID it already saved. The
 * UNIQUE on room_id in schema.prisma is what makes that work.
 *
 * `creatorKey` may be present on the snapshot — it is the room creator's IP,
 * used only as the queue's pacing key. The INSERT lists its columns explicitly,
 * so it cannot reach the database: **no IP is ever written to Postgres.**
 *
 * @param {{
 *   roomId: string,
 *   userIds: string[],
 *   files: Array<{filename: string, content: string}>,
 *   language?: string | null,
 *   isPrivate?: boolean,
 *   participants?: Array<{name: string, color: string}> | null,
 *   createdAt: Date,
 *   diedAt: Date,
 *   creatorKey?: string,
 * }} snapshot
 * @returns {Promise<"written" | "skipped" | "failed" | "disabled">}
 */
async function saveDeadRoom(snapshot) {
  if (!pool) return "disabled";

  /** @type {import("pg").PoolClient | null} */
  let client = null;
  try {
    // A checked-out client, not pool.query. `pool.query("BEGIN")` is not a
    // transaction: with max:3 the BEGIN, the INSERTs and the COMMIT can each
    // land on a *different* pooled connection, so the inserts run outside the
    // transaction and the COMMIT commits nothing at all. It fails silently —
    // the rows appear, so it looks like it worked.
    client = await pool.connect();
    await client.query("BEGIN");

    const inserted = await client.query(
      // gen_random_uuid() stays: @default(uuid()) in schema.prisma is a
      // *Prisma-side* default, so the generated migration declares
      // `"id" UUID NOT NULL` with no DEFAULT clause. This process has no Prisma
      // client to mint one. RETURNING hands it back for the members insert.
      // `died_at` is bound, NOT `now()`. Since 7.5 a write can be paced, so the
      // INSERT may run seconds or minutes after the room actually died —
      // `now()` would record when Postgres was reached rather than when the
      // last person left. Both of /profile's uses would then be wrong:
      // `deadRooms.ts` orders the listing by `died_at`, so a deferred room would
      // sort below a later one that wrote immediately, and `lifetime()` renders
      // `died_at - created_at` under each snapshot, which the delay inflates.
      `INSERT INTO dead_rooms
         (id, room_id, files, language, is_private, participants, created_at, died_at)
       VALUES
         (gen_random_uuid(), $1, $2::jsonb, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (room_id) DO NOTHING
       RETURNING id`,
      [
        snapshot.roomId,
        JSON.stringify(snapshot.files),
        snapshot.language ?? null,
        snapshot.isPrivate ?? false,
        snapshot.participants?.length ? JSON.stringify(snapshot.participants) : null,
        snapshot.createdAt,
        snapshot.diedAt,
      ],
    );

    // Read the returned id, not rowCount: with DO NOTHING a conflict yields an
    // empty `rows` array, and the id is what the members insert needs anyway.
    const deadRoomId = inserted.rows[0]?.id;
    if (!deadRoomId) {
      // This room_id was already snapshotted. The first write is authoritative
      // and a snapshot is never updated (§6.1), so the members are deliberately
      // left alone rather than topped up — that would mutate who can read a
      // snapshot after the fact. Commit the empty transaction; do not retry.
      await client.query("COMMIT");
      console.warn(`Dead room ${snapshot.roomId} was already saved; left untouched.`);
      return "skipped";
    }

    // One statement, not one per user: this runs inside the shutdown flush
    // budget, where each extra round trip to Neon is a snapshot that might not
    // land before the process is killed.
    if (snapshot.userIds.length > 0) {
      await client.query(
        `INSERT INTO dead_room_members (dead_room_id, user_id)
         SELECT $1::uuid, u FROM unnest($2::text[]) AS u
         ON CONFLICT DO NOTHING`,
        [deadRoomId, snapshot.userIds],
      );
    }

    await client.query("COMMIT");
    return "written";
  } catch (err) {
    // `client` is null when the failure *was* `pool.connect()`; there is no
    // transaction to roll back in that case.
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(`Failed to save dead room ${snapshot.roomId}:`, err.message);
    return "failed";
  } finally {
    // Mandatory. A leaked client out of a pool of 3 means the next two snapshots
    // block for connectionTimeoutMillis and then fail, and the third onwards
    // never runs at all.
    if (client) client.release();
  }
}

/** Closes the pool so a shutdown can finish. No-op when no pool was opened. */
async function close() {
  if (!pool) return;
  await pool.end().catch((err) => {
    console.error("Error closing Postgres pool:", err.message);
  });
}

module.exports = { POOL_MAX, isEnabled, saveDeadRoom, close };
