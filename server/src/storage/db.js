// The sync server's only connection to Postgres: one hand-written INSERT, no ORM.
// INVARIANT: keep the columns below in sync with web/prisma/schema.prisma by hand.
// INVARIANT: only storage/snapshotQueue.js may call saveDeadRoom — it bounds concurrency.

const { Pool } = require("pg");
const { intFromEnv } = require("../env");

// INVARIANT: snapshotQueue.js caps its concurrency at exactly this. Another consumer of
// this pool means that cap must drop below POOL_MAX.
const POOL_MAX = 3;

// Optional: unset, no pool opens and saveDeadRoom is a no-op, so guests need no database.
const CONNECTION_STRING = process.env.DATABASE_URL;

// 0 is legitimate and distinct: pg reads it as "no timeout". Exported so index.js can check the
// ordering against SNAPSHOT_FLUSH_MS at boot, which CLAUDE.md documented but nothing enforced.
const CONNECT_TIMEOUT_MS = intFromEnv(process.env.DB_CONNECT_TIMEOUT_MS, 10_000, {
  name: "DB_CONNECT_TIMEOUT_MS",
});

/** @type {import("pg").Pool | null} */
let pool = null;

if (CONNECTION_STRING) {
  pool = new Pool({
    connectionString: CONNECTION_STRING,
    max: POOL_MAX,
    // INVARIANT: must stay below the shutdown flush deadline in rooms/lifecycle.js
    // and above a Neon cold start (>5s measured against a suspended branch).
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    ssl: { rejectUnauthorized: true },
  });

  // INVARIANT: mandatory — Neon drops idle connections, and an unhandled pool
  // 'error' is an uncaught exception that would kill every live room.
  pool.on("error", (err) => {
    console.error("Postgres pool error (ignored, rooms are unaffected):", err.message);
  });
}

function isEnabled() {
  return pool !== null;
}

/**
 * INVARIANT: every ID in `userIds` came from a token this server verified, never awareness.
 * INVARIANT: never throws or rejects — snapshotQueue.js's worker chain has no other catcher,
 * which is why `pool.connect()` sits inside the try.
 * INVARIANT: `creatorKey` is the creator's IP; the explicit column list keeps it out of Postgres.
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
    // INVARIANT: a checked-out client, never pool.query("BEGIN") — with max > 1 the
    // statements land on different connections and the COMMIT silently commits nothing.
    client = await pool.connect();
    await client.query("BEGIN");

    const inserted = await client.query(
      // INVARIANT: gen_random_uuid() stays — @default(uuid()) in schema.prisma is
      // Prisma-side only and this process has no Prisma client to mint an id.
      // INVARIANT: bind `died_at`, never now() — /profile sorts on it and shows the lifetime.
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

    // Read the returned id, not rowCount: with DO NOTHING a conflict yields no rows.
    const deadRoomId = inserted.rows[0]?.id;
    if (!deadRoomId) {
      // Already saved; the first write is authoritative (§6.1), so members are not
      // topped up — that would change who can read the snapshot.
      await client.query("COMMIT");
      console.warn(`Dead room ${snapshot.roomId} was already saved; left untouched.`);
      return "skipped";
    }

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
    // `client` is null when the failure *was* `pool.connect()`.
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(`Failed to save dead room ${snapshot.roomId}:`, err.message);
    return "failed";
  } finally {
    // INVARIANT: mandatory — a leaked client out of a pool of 3 fails the next snapshots.
    if (client) client.release();
  }
}

async function close() {
  if (!pool) return;
  await pool.end().catch((err) => {
    console.error("Error closing Postgres pool:", err.message);
  });
}

module.exports = { POOL_MAX, CONNECT_TIMEOUT_MS, isEnabled, saveDeadRoom, close };
