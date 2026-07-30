// The shape of a multi-file room, as every peer in the room sees it (§10.1).
//
// Free of React and browser APIs, for the same reason `lib/sandbox/executionState.ts`
// is: the collab hook, the tab bar, the runner and Save all need these names and
// none of them may invent their own.
//
// ---------------------------------------------------------------------------
// THE DOCUMENT SHAPE
//
//   yDoc
//    ├─ Y.Map  "files"     fileId -> { name, createdAt }
//    ├─ Y.Map  "roomMeta"  "entry" -> fileId
//    ├─ Y.Text "file:<id>" one per file
//    └─ Y.Map  "execution" unchanged (see lib/sandbox/executionState.ts)
//
// tasks.md §10.1 asks for "each file = its own Yjs sub-document". Real Yjs
// subdocuments are NOT synced by this stack: `setupWSConnection` in
// y-websocket/bin/utils.js syncs exactly one doc per socket and never handles
// `doc.on('subdocs')`, so every file would need its own provider, its own gated
// WebSocket and its own token-refresh path, plus new child-doc handling in
// `server/src/rooms/lifecycle.js` and `server/src/rooms/state.js`. A `Y.Text` per file on the *same*
// doc is the trick the shared `execution` map already uses: y-websocket's sync
// protocol does not distinguish between shared types, it merges the whole
// document, so all of this reaches every peer — late joiners included — with
// zero server changes. The checklist bullet was rewritten to say so.
// ---------------------------------------------------------------------------
//
// THREE RULES, each closing a real hole:
//
//  1. The first file's id is the literal `ENTRY_FILE_ID`, never a random one.
//     Two peers syncing into an empty room concurrently both run the seed; with
//     random ids they would create two `main.py`s that CRDT-merge into two tabs.
//     A fixed key means they write the same map entry and the same `Y.Text`, so
//     they converge on one file — and the seed's text insert becomes the same
//     benign duplicate-insert case v1 already had.
//  2. Tab order is DERIVED, never stored: `createdAt`, tiebroken by id. A shared
//     order array would need its own conflict story (two peers reordering, an
//     entry for a file another peer deleted); a derived order is one every peer
//     computes identically from data they already have.
//  3. A file's metadata is replaced WHOLE per key, exactly as `EXECUTION_KEY` is
//     — a rename writes `files.set(id, {...meta, name})`. Never a nested Y.Map
//     per file: two peers touching different fields would otherwise interleave
//     into a record neither wrote.

import { fileExtFor } from "@/lib/editor/languages";

/** The `Y.Map` of file metadata, keyed by file id. */
export const FILES_MAP_NAME = "files";

/** The `Y.Map` holding room-wide pointers. One key today. */
export const ROOM_META_MAP_NAME = "roomMeta";

/** The key in {@link ROOM_META_MAP_NAME} naming the file Run executes. */
export const ENTRY_KEY = "entry";

/**
 * The id of the file every room starts with. Fixed, not random — see rule 1.
 * Mirrored in `server/src/rooms/state.js`, which needs no such constant today (it
 * walks whatever keys the map holds) but reads the same `file:` prefix.
 */
export const ENTRY_FILE_ID = "main";

/** The `Y.Text` name carrying one file's contents. */
export function fileTextName(fileId: string): string {
  return `file:${fileId}`;
}

/**
 * The Monaco model URI for one file, and the value `EditorPane`'s `path` prop
 * carries.
 *
 * Keyed on the file **id**, never its name: `@monaco-editor/react` resolves
 * `path` through `Uri.parse` and `editor.getModel(uri)`, so a name in the URI
 * would orphan the model (and its `MonacoBinding`) on every rename. The room id
 * is in there so two rooms open in one browser session cannot collide on a
 * model — Monaco's model registry is global to the page, not to a component.
 */
export function modelPathFor(roomId: string, fileId: string): string {
  return `inmemory://room/${roomId}/${fileId}`;
}

/**
 * Files per room. Bounds three things at once: the tab strip's width, the number
 * of live Monaco models and `MonacoBinding`s the room holds, and how many entries
 * a snapshot can carry into `dead_rooms.files`.
 */
export const MAX_FILES = 20;

/** Longest filename, matching `MAX_FILENAME_LENGTH` in `lib/data/deadRooms.ts`. */
export const MAX_FILENAME_LENGTH = 64;

/** One file, as the UI may render it. Always sanitized — see {@link readRoomFiles}. */
export type RoomFile = {
  id: string;
  /** Sanitized, deduplicated, and safe to hand to `<a download>`. */
  name: string;
  createdAt: number;
};

/** What actually sits in the `Y.Map`. Peer-supplied, so never rendered raw. */
export type RoomFileMeta = {
  name: string;
  createdAt: number;
};

const FALLBACK_STEM = "untitled";

/**
 * Verbatim copy of `UNSTORABLE` in `server/src/rooms/state.js`.
 *
 * A filename typed here ends up in `dead_rooms.files`, and neither a NUL nor an
 * unpaired surrogate can reach a Postgres column — the surrogate is the worse of
 * the two, because `JSON.stringify` emits a bare `"\ud83d"` and Postgres then
 * rejects the *whole* INSERT, so one bad character in one filename would lose the
 * room's code as well. The server strips these again on its own side; stripping
 * here as well means the name in the tab is the name in the snapshot.
 */
const UNSTORABLE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Appends a `(2)`, `(3)`… before the extension. `main.py` -> `main (2).py`. */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * A filename safe to render, to key a Monaco model on, and to hand to
 * `<a download>` or a zip entry.
 *
 * The counterpart to `safeFilename` in `lib/data/deadRooms.ts`, one layer earlier: that
 * one guards what comes *out* of Postgres, this one guards what a peer puts into
 * the shared doc. Path separators matter most — a download attribute and a JSZip
 * key both interpret them rather than merely displaying them.
 *
 * The cut is by code point, not `slice`, for the same reason `sanitizeName` in
 * `server/src/rooms/state.js` is: a 64-code-*unit* slice can halve a surrogate pair, and
 * a lone surrogate later takes the room's whole snapshot down with it.
 */
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

/** A file id a peer may have invented. Kept short and printable — it becomes a URI. */
function isUsableId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && /^[\w.-]+$/.test(id);
}

/**
 * Turns the raw `files` map into a list the UI may render, sorted into tab order.
 *
 * **This is a sanitizing boundary, in the same category as `readPeers` in
 * `lib/collab/awareness.ts`.** Everything in that map is peer-supplied: a raw Yjs client
 * can write any name, any id and any `createdAt`, and the name then reaches a tab
 * label, an `<a download>`, a zip entry key, and ultimately `dead_rooms.files`.
 * Nothing may read `yDoc.getMap(FILES_MAP_NAME)` directly.
 *
 * Names are deduplicated the same way `readPeers` deduplicates display names:
 * reactively, once the collision is visible, walking in the one order every peer
 * agrees on so all viewers pick the same winner.
 */
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

  // Rule 2: derived order, identical on every peer. The id tiebreak matters —
  // two files created in the same millisecond are not rare when one peer adds
  // two in a row.
  files.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Collisions are resolved *after* the sort, so every viewer numbers them the
  // same way. `main.py` / `main.py` becomes `main.py` / `main (2).py`.
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

/**
 * Which file Run executes: the recorded entry if it still exists, else the first
 * tab. The fallback is not defensive — deleting the entry file is allowed, and
 * two peers can delete and re-point concurrently, so "the pointer names a file
 * that is gone" is a state the document legitimately reaches.
 */
export function resolveEntryFile(files: RoomFile[], entryId: unknown): RoomFile | null {
  if (files.length === 0) return null;
  return files.find((file) => file.id === entryId) ?? files[0];
}
