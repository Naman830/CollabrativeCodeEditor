// The one place the app *reads* `dead_rooms`, and the boundary that turns a
// `jsonb` column into values the profile page may render.
//
// Server-only, for the same reason as `./db.ts` (which it imports): never import
// this from a `"use client"` module, or the database driver and the connection
// string start walking toward the browser bundle.
//
// ---------------------------------------------------------------------------
// HARD RULE: a `DeadRoom` is never fetched by its id.
//
// Every read below starts from `deadRoomMember`, keyed on the *viewer's* Clerk
// user ID, and reaches the room through the relation. A snapshot the viewer
// holds no membership row for is therefore not "hidden by a filter we
// remembered to add" — it is unfetchable, because the row that names it was
// never in the result set. tasks.md §6.1 puts a room on several people's
// profiles at once, so an ownership column cannot do this job and there isn't
// one to check against.
// ---------------------------------------------------------------------------

import { prisma } from "./db";

/** One file inside a snapshot. Always at least one; today always exactly one. */
export type SnapshotFile = {
  filename: string;
  content: string;
};

/** What the listing needs. Deliberately no `files` — see {@link listDeadRoomsForUser}. */
export type DeadRoomSummary = {
  id: string;
  roomId: string;
  language: string | null;
  isPrivate: boolean;
  createdAt: Date;
  diedAt: Date;
};

export type DeadRoomDetail = DeadRoomSummary & {
  files: SnapshotFile[];
};

export type DeadRoomListing = {
  rooms: DeadRoomSummary[];
  /** True when the cap below hid rows. Never truncate silently. */
  capped: boolean;
};

/**
 * Rows fetched for one profile. There is no pagination in v2 and no `died_at`
 * index to page against — 7.3's migration dropped the only secondary index, so
 * the composite primary key `(user_id, dead_room_id)` serves the filter and the
 * sort happens after the join.
 */
const LIST_LIMIT = 100;

/**
 * `dead_rooms.id` is a Postgres `uuid`, so a malformed path segment does not
 * come back as "not found" — it reaches the driver and fails the statement with
 * `invalid input syntax for type uuid`, i.e. a 500 on a URL a user can type.
 * Guard before querying.
 */
export const DEAD_ROOM_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verbatim copy of `TRUNCATION_MARKER` in `server/roomState.js`.
 *
 * The fourth hand-maintained duplication across the two workspaces, after
 * `rateLimit.js`/`rateLimit.ts`, `CLOSE_ROOM_NOT_FOUND`, and `roomState.js`'s
 * copies of `sanitizeName`/`HEX_COLOR`. The workspaces share no code and the
 * server has no build step, so this string must be kept in step by hand; if it
 * drifts, the only symptom is a truncated snapshot quietly losing its notice.
 */
const TRUNCATION_MARKER = "\n\n/* --- snapshot truncated: room exceeded 256 KB --- */\n";

/** Longest filename rendered, and the longest one handed to `<a download>`. */
const MAX_FILENAME_LENGTH = 64;
const FALLBACK_FILENAME = "main.txt";

/** Guards against a `files` array that is somehow enormous. Today it holds one. */
const MAX_FILES = 50;

/**
 * Was this snapshot cut off at the 256 KB cap?
 *
 * `endsWith`, never `includes`: the marker is always a suffix, and a user is
 * perfectly free to have typed that sentence into their own code.
 */
export function isTruncated(content: string): boolean {
  return content.endsWith(TRUNCATION_MARKER);
}

/**
 * A filename safe to render and to hand to `<a download>`.
 *
 * The server writes the literal `"main.txt"` today, but this reads a `jsonb`
 * column: Prisma types it `JsonValue` and guarantees nothing about its shape, so
 * this is the same kind of boundary `lib/awareness.ts` is for peer state. Path
 * separators matter most — a download attribute is the one place a filename is
 * interpreted rather than merely displayed.
 */
function safeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[/\\]/g, "")
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  // "." and ".." survive the replacements above and are not filenames.
  return /[^.]/.test(cleaned) ? cleaned : FALLBACK_FILENAME;
}

/**
 * Narrows the `files` column. The counterpart to `readPeers` in
 * `lib/awareness.ts`: one place turns an untyped value into something the UI may
 * render, and no component reads the raw column.
 *
 * Always returns at least one entry, so no caller has to render "a snapshot with
 * no files" — a state that would mean the row was written wrong, not that the
 * user has an empty room.
 */
export function readSnapshotFiles(value: unknown): SnapshotFile[] {
  const entries = Array.isArray(value) ? value : [];
  const files: SnapshotFile[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { filename, content } = entry as { filename?: unknown; content?: unknown };
    files.push({
      filename: safeFilename(typeof filename === "string" ? filename : ""),
      content: typeof content === "string" ? content : "",
    });
    if (files.length >= MAX_FILES) break;
  }

  if (files.length === 0) files.push({ filename: FALLBACK_FILENAME, content: "" });
  return files;
}

/**
 * Every snapshot this user may see, newest death first.
 *
 * `files` is deliberately **not** selected. A snapshot's content is capped at
 * 256 KB, so selecting it here would pull up to ~25 MB out of Neon to render a
 * page of metadata cards. That is also why the cards carry no code preview: a
 * preview needs a `$queryRaw` with a `jsonb` substring, not a wider `select`.
 */
export async function listDeadRoomsForUser(userId: string): Promise<DeadRoomListing> {
  const rows = await prisma.deadRoomMember.findMany({
    where: { userId },
    select: {
      deadRoom: {
        select: {
          id: true,
          roomId: true,
          language: true,
          isPrivate: true,
          createdAt: true,
          diedAt: true,
        },
      },
    },
    orderBy: { deadRoom: { diedAt: "desc" } },
    // One more than the cap, purely to learn whether the cap bit.
    take: LIST_LIMIT + 1,
  });

  return {
    rooms: rows.slice(0, LIST_LIMIT).map((row) => row.deadRoom),
    capped: rows.length > LIST_LIMIT,
  };
}

/**
 * One snapshot, or null — which covers "no such row" and "not yours" with the
 * same answer, on purpose. `findUnique` on the composite primary key is both the
 * index-served lookup and the authorization check; see this file's HARD RULE.
 */
export async function getDeadRoomForUser(
  userId: string,
  deadRoomId: string
): Promise<DeadRoomDetail | null> {
  if (!DEAD_ROOM_ID.test(deadRoomId)) return null;

  const membership = await prisma.deadRoomMember.findUnique({
    where: { userId_deadRoomId: { userId, deadRoomId } },
    include: { deadRoom: true },
  });
  if (!membership) return null;

  const { deadRoom } = membership;
  return {
    id: deadRoom.id,
    roomId: deadRoom.roomId,
    language: deadRoom.language,
    isPrivate: deadRoom.isPrivate,
    createdAt: deadRoom.createdAt,
    diedAt: deadRoom.diedAt,
    files: readSnapshotFiles(deadRoom.files),
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers.
//
// Deliberately relative ("closed 3 hours ago") and duration-based ("lasted 12
// min") rather than a formatted local timestamp: both are pure deltas, so they
// are identical on the server and in the browser. A locale- or timezone-formatted
// absolute date rendered on the server is a hydration mismatch waiting to happen
// — and this page is server-rendered precisely so it needs no client JS. The
// exact instant still travels, in `<time dateTime>` and the `title`.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "just now" / "8 minutes ago" / "3 days ago". */
export function relativeTime(date: Date, now: number = Date.now()): string {
  const ms = Math.max(0, now - date.getTime());
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${plural(Math.floor(ms / MINUTE), "minute")} ago`;
  if (ms < DAY) return `${plural(Math.floor(ms / HOUR), "hour")} ago`;
  return `${plural(Math.floor(ms / DAY), "day")} ago`;
}

/** How long the room was alive: "42 seconds", "12 minutes", "1 hour 5 minutes". */
export function lifetime(createdAt: Date, diedAt: Date): string {
  const ms = Math.max(0, diedAt.getTime() - createdAt.getTime());
  if (ms < MINUTE) return plural(Math.round(ms / 1000), "second");
  if (ms < HOUR) return plural(Math.round(ms / MINUTE), "minute");

  const hours = Math.floor(ms / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  return minutes === 0
    ? plural(hours, "hour")
    : `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
}

/** UTC, spelled out. Only ever a `title`/`dateTime` value, never the headline. */
export function absoluteTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
