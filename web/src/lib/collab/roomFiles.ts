// The shared shape of a multi-file room: document names, limits, and the
// sanitizing boundary every reader of the `files` map goes through.

import { fileExtFor } from "@/lib/editor/languages";

export const FILES_MAP_NAME = "files";

export const ROOM_META_MAP_NAME = "roomMeta";

/** The key in {@link ROOM_META_MAP_NAME} naming the file Run executes. */
export const ENTRY_KEY = "entry";

// INVARIANT: fixed, never random — two peers seeding an empty room concurrently must
// converge on one file. The `file:` prefix is mirrored in server/src/rooms/state.js.
export const ENTRY_FILE_ID = "main";

export function fileTextName(fileId: string): string {
  return `file:${fileId}`;
}

// INVARIANT: keyed on the file id, never its name — a name here orphans the Monaco
// model and its binding on rename. The room id scopes Monaco's page-global registry.
export function modelPathFor(roomId: string, fileId: string): string {
  return `inmemory://room/${roomId}/${fileId}`;
}

export const MAX_FILES = 20;

/** Keep in sync with `MAX_FILENAME_LENGTH` in `lib/data/deadRooms.ts`. */
export const MAX_FILENAME_LENGTH = 64;

/** One file, as the UI may render it. Always sanitized — see {@link readRoomFiles}. */
export type RoomFile = {
  id: string;
  name: string;
  createdAt: number;
};

/** What actually sits in the `Y.Map`. Peer-supplied, so never rendered raw. */
export type RoomFileMeta = {
  name: string;
  createdAt: number;
};

const FALLBACK_STEM = "untitled";

// INVARIANT: keep in sync with `UNSTORABLE` in server/src/rooms/state.js — a NUL or
// unpaired surrogate in a filename rejects the whole dead_rooms INSERT.
const UNSTORABLE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// INVARIANT: peer-supplied names reach `<a download>`, zip keys and dead_rooms.files, so
// separators must go; the cut is by code point so no surrogate pair is halved.
export function sanitizeFileName(raw: unknown, language?: string): string {
  const cleaned =
    typeof raw === "string"
      ? raw
          .replace(UNSTORABLE, "")
          .replace(/[\u0000-\u001F\u007F]/g, "")
          .replace(/[/\\]/g, "")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  const cut = [...cleaned].slice(0, MAX_FILENAME_LENGTH).join("").trim();
  // "." and ".." survive every replacement above and are not filenames.
  if (!/[^.]/.test(cut)) {
    return language ? `${FALLBACK_STEM}.${fileExtFor(language)}` : `${FALLBACK_STEM}.txt`;
  }
  return cut;
}

function isUsableId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && /^[\w.-]+$/.test(id);
}

// INVARIANT: the only sanitizing boundary for the peer-supplied `files` map — nothing
// may read `yDoc.getMap(FILES_MAP_NAME)` directly.
export function readRoomFiles(
  entries: Iterable<[string, unknown]>,
  language?: string,
): RoomFile[] {
  const files: RoomFile[] = [];

  for (const [id, value] of entries) {
    if (!isUsableId(id)) continue;
    if (!value || typeof value !== "object") continue;
    const { name, createdAt } = value as Partial<RoomFileMeta>;
    files.push({
      id,
      name: sanitizeFileName(name, language),
      createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
    });
  }

  // Order is derived, never stored, so every peer computes it identically; the id
  // tiebreak covers two files created in the same millisecond.
  files.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // After the sort, so every viewer numbers a collision the same way.
  const seen = new Set<string>();
  for (const file of files) {
    let candidate = file.name;
    for (let n = 2; seen.has(candidate.toLowerCase()); n += 1) {
      candidate = numbered(file.name, n);
    }
    seen.add(candidate.toLowerCase());
    file.name = candidate;
  }

  return files.slice(0, MAX_FILES);
}

// The fallback is not defensive: deleting the entry file is allowed, so "the pointer
// names a file that is gone" is a state the document legitimately reaches.
export function resolveEntryFile(files: RoomFile[], entryId: unknown): RoomFile | null {
  if (files.length === 0) return null;
  return files.find((file) => file.id === entryId) ?? files[0];
}
