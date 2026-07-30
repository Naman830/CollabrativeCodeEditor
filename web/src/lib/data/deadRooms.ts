// INVARIANT: server-only — never import from a `"use client"` module (pulls in the DB driver).
// INVARIANT: never fetch a DeadRoom by id; every read starts from deadRoomMember on the viewer's id.

import { prisma } from "./db";

export type SnapshotFile = {
  filename: string;
  content: string;
};

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
  capped: boolean;
};

const LIST_LIMIT = 100;

// Must gate every query: a malformed segment reaches the driver and 500s on the uuid cast.
export const DEAD_ROOM_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keep in sync with TRUNCATION_MARKER in server/src/rooms/state.js.
const TRUNCATION_MARKER = "\n\n/* --- snapshot truncated: room exceeded 256 KB --- */\n";

const MAX_FILENAME_LENGTH = 64;
const FALLBACK_FILENAME = "main.txt";

const MAX_FILES = 50;

// `endsWith`, never `includes`: a user may have typed the marker's text themselves.
export function isTruncated(content: string): boolean {
  return content.endsWith(TRUNCATION_MARKER);
}

// INVARIANT: the `files` jsonb is untrusted; a filename reaching `<a download>` must lose
// path separators and control characters.
function safeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[/\\]/g, "")
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  // "." and ".." survive the replacements above and are not filenames.
  return /[^.]/.test(cleaned) ? cleaned : FALLBACK_FILENAME;
}

// INVARIANT: the only boundary that narrows the raw `files` column — no component reads it
// directly. Always returns at least one entry.
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

// `files` must stay out of this select: 100 rows x 256 KB pulled from Neon to render cards.
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
    // +1 so a hit cap can be detected rather than silently truncating.
    take: LIST_LIMIT + 1,
  });

  return {
    rooms: rows.slice(0, LIST_LIMIT).map((row) => row.deadRoom),
    capped: rows.length > LIST_LIMIT,
  };
}

// null for both "no such row" and "not yours", or the URL becomes an existence oracle.
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

// Deletes the viewer's membership row; drops the snapshot only when that was its last member.
// false covers both "no such row" and "not yours", so it cannot probe which ids exist.
export async function deleteDeadRoomForUser(
  userId: string,
  deadRoomId: string
): Promise<boolean> {
  if (!DEAD_ROOM_ID.test(deadRoomId)) return false;

  return prisma.$transaction(async (tx) => {
    // `deleteMany`, not `delete`: a missing row is an ordinary count of 0, not a throw.
    const removed = await tx.deadRoomMember.deleteMany({
      where: { userId, deadRoomId },
    });
    if (removed.count === 0) return false;

    const remaining = await tx.deadRoomMember.count({ where: { deadRoomId } });
    if (remaining === 0) {
      await tx.deadRoom.delete({ where: { id: deadRoomId } });
    }
    return true;
  });
}

// Relative deltas only: a locale-formatted absolute date rendered on the server is a
// hydration mismatch on a page that otherwise ships no client JS.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function relativeTime(date: Date, now: number = Date.now()): string {
  const ms = Math.max(0, now - date.getTime());
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${plural(Math.floor(ms / MINUTE), "minute")} ago`;
  if (ms < DAY) return `${plural(Math.floor(ms / HOUR), "hour")} ago`;
  return `${plural(Math.floor(ms / DAY), "day")} ago`;
}

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

export function absoluteTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
