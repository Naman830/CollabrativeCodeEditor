// The sync server's only connection to Postgres.
//
// This process writes one row in a room's entire life — the snapshot taken when
// the room dies — and never reads or updates one. That is why there is no ORM
// here: `collab-code-editor/prisma/schema.prisma` is the authority on the
// table's shape, and this file hand-writes the single INSERT it implies. Adding
// Prisma would mean a second schema copy, a `prisma generate` step, and the
// query engine in a Railway image, all to serve one statement.
//
// The cost is the same deliberate duplication as rateLimit.js / rateLimit.ts:
// the two workspaces share no code, so a column renamed in schema.prisma must
// be renamed in the INSERT below. There is no build step that would catch it.
//
// Nothing here is called yet — task 7.3 wires it into the eviction path in
// rooms.js. 7.2 only proves the connection works.

const { Pool } = require("pg");

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
    max: 3,
    // A snapshot is not worth blocking shutdown over. If the database is
    // unreachable the write fails fast and the room is destroyed anyway.
    connectionTimeoutMillis: 10_000,
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
 * Writes one dead-room snapshot. Called exactly once per room, by the eviction
 * path in rooms.js (task 7.3).
 *
 * Never throws: a failed snapshot must not stop a room being destroyed, and
 * there is nobody left in the room to report an error to. Returns whether the
 * row was written.
 *
 * ON CONFLICT DO NOTHING enforces the write-once rule against retries and
 * against a server restart that re-evicts a room ID it already saved. The
 * UNIQUE on room_id in schema.prisma is what makes that work.
 *
 * @param {{
 *   roomId: string,
 *   ownerUserId: string,
 *   files: Array<{filename: string, content: string}>,
 *   language?: string | null,
 *   isPrivate?: boolean,
 *   participants?: Array<{name: string, color: string}> | null,
 *   createdAt: Date,
 * }} snapshot
 * @returns {Promise<boolean>}
 */
async function saveDeadRoom(snapshot) {
  if (!pool) return false;

  try {
    const result = await pool.query(
      `INSERT INTO dead_rooms
         (id, room_id, owner_user_id, files, language, is_private, participants, created_at, died_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, now())
       ON CONFLICT (room_id) DO NOTHING`,
      [
        snapshot.roomId,
        snapshot.ownerUserId,
        JSON.stringify(snapshot.files),
        snapshot.language ?? null,
        snapshot.isPrivate ?? false,
        snapshot.participants ? JSON.stringify(snapshot.participants) : null,
        snapshot.createdAt,
      ],
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error(`Failed to save dead room ${snapshot.roomId}:`, err.message);
    return false;
  }
}

module.exports = { isEnabled, saveDeadRoom };
