// What a room was, as opposed to whether it exists.
// INVARIANT: every function here is lookup-only — an observer that creates state
// resurrects a room doc.destroy() just killed, and nothing deletes it again.

const { intFromEnv } = require("../env");

// INVARIANT: keep in sync with web/src/lib/data/persistence.ts, which hardcodes
// this default and cannot see the env override.
// 0 is legitimate and is the value people actually want in tests: everyone qualifies at once.
const MEMBER_MIN_CONNECTED_MS = intFromEnv(process.env.MEMBER_MIN_CONNECTED_MS, 60_000, {
  name: "MEMBER_MIN_CONNECTED_MS",
});

const MAX_SNAPSHOT_BYTES = 256 * 1024;
// INVARIANT: keep in sync with web/src/lib/data/deadRooms.ts, which matches on it.
const TRUNCATION_MARKER = "\n\n/* --- snapshot truncated: room exceeded 256 KB --- */\n";

// Ceilings on peer-supplied data accumulated over a room's whole life.
const MAX_MEMBERS = 200;
const MAX_PARTICIPANTS = 50;
const MAX_PENDING_EDITS = 500;

const MAX_NAME_LENGTH = 24; // == web/src/lib/collab/user.ts
const HEX_COLOR = /^#[0-9a-f]{6}$/i; // == web/src/lib/collab/awareness.ts
const FALLBACK_COLOR = "#9e9e9e"; // == web/src/lib/collab/awareness.ts

// Shared-document names; keep in sync with web/src/lib/collab/roomFiles.ts.
const FILES_MAP_NAME = "files";
const FILE_TEXT_PREFIX = "file:";
// Pre-§10.1 rooms kept everything here; snapshotFiles still falls back to it.
const LEGACY_TEXT_NAME = "monaco";
const MAX_FILES = 20; // == web/src/lib/collab/roomFiles.ts
const MAX_FILENAME_LENGTH = 64; // == web/src/lib/collab/roomFiles.ts

// INVARIANT: an allowlist, not "store whatever arrived" — `?language=` is anonymous
// input that reaches dead_rooms.language. == web/src/lib/editor/languages.ts
const ROOM_LANGUAGES = ["javascript", "python", "typescript", "java", "cpp"];
const DEFAULT_LANGUAGE = "javascript"; // == web/src/lib/editor/languages.ts

// == `ext` in web/src/lib/editor/languages.ts
const LANGUAGE_EXT = {
  javascript: "js",
  python: "py",
  typescript: "ts",
  java: "java",
  cpp: "cpp",
};

/** == `downloadFileName` in web/src/lib/editor/languages.ts. */
function defaultFileName(language) {
  if (language === "java") return "Main.java";
  return `main.${LANGUAGE_EXT[language] ?? "txt"}`;
}

function normalizeLanguage(raw) {
  return ROOM_LANGUAGES.includes(raw) ? raw : DEFAULT_LANGUAGE;
}

// INVARIANT: NUL and unpaired surrogates cannot reach a Postgres column - a lone
// surrogate fails the entire INSERT, losing the room's code with it.
const UNSTORABLE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripUnstorable(raw) {
  return raw.replace(UNSTORABLE, "");
}

/** roomId -> room state. Only `createRoomState` ever adds a key. */
const states = new Map();

// INVARIANT: get-or-create — `claimRoom` calls this with no creatorKey, so never
// overwrite. creatorKey is the creator's IP: memory only, never a stored column.
function createRoomState(roomId, creatorKey = null, language = null) {
  const existing = states.get(roomId);
  if (existing) return existing;

  const state = {
    createdAt: Date.now(),
    creatorKey,
    language: normalizeLanguage(language),
    members: new Map(),
    participants: new Map(),
    // Socket -> verified user ID: Yjs hands the socket as the transaction origin.
    connUsers: new Map(),
    // Sockets that edited before their token verified; drained by beginMemberSession.
    pendingEdits: new Set(),
    updateBound: false,
    awarenessBound: false,
  };
  states.set(roomId, state);
  return state;
}

function getRoomState(roomId) {
  return states.get(roomId) ?? null;
}

function deleteRoomState(roomId) {
  states.delete(roomId);
}

// INVARIANT: the only accessor — never read `connectedMs` raw; it omits the session
// still open, which at the SIGTERM flush is every member's whole session.
function elapsedMs(member, now) {
  return member.connectedMs + (member.openCount > 0 ? now - member.sessionStartedAt : 0);
}

/** Reference-counted: one user can hold several sockets (two tabs, or a reconnect). */
function beginMemberSession(roomId, userId, at, conn) {
  const state = getRoomState(roomId);
  if (!state) return;

  let member = state.members.get(userId);
  if (!member) {
    if (state.members.size >= MAX_MEMBERS) return;
    member = {
      connectedMs: 0,
      openCount: 0,
      sessionStartedAt: at,
      lastActiveAt: 0,
      didEdit: false,
    };
    state.members.set(userId, member);
  }

  // INVARIANT: set only on the 0 -> 1 transition, and Math.min because verification
  // resolves out of socket order — otherwise an earlier connect time is discarded.
  member.sessionStartedAt =
    member.openCount === 0 ? at : Math.min(member.sessionStartedAt, at);
  member.openCount += 1;

  if (conn) {
    state.connUsers.set(conn, userId);
    if (state.pendingEdits.delete(conn)) member.didEdit = true;
  }
}

/** Called for every closing socket, verified or not, or a guest's entry leaks. */
function forgetConn(roomId, conn) {
  const state = getRoomState(roomId);
  if (state) state.pendingEdits.delete(conn);
}

// INVARIANT: at most once per socket (the `ended` flag in server/src/sync/connection.js);
// a double decrement strands openCount and that member's time stops accruing.
function endMemberSession(roomId, userId, at, conn) {
  const state = getRoomState(roomId);
  if (!state) return;

  if (conn) state.connUsers.delete(conn);

  const member = state.members.get(userId);
  if (!member || member.openCount === 0) return;

  member.openCount -= 1;
  if (member.openCount === 0) {
    member.connectedMs += at - member.sessionStartedAt;
    member.lastActiveAt = at;
  }
}

// Peer-supplied, and rendered on /profile. Cut by code point, not slice: a halved
// surrogate pair would take the whole snapshot down with it.
function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  const cleaned = stripUnstorable(raw)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, MAX_NAME_LENGTH).join("");
}

/** Idempotent. Both handlers are lookup-only — see the invariant at the top. */
function bindRoomObservers(roomId, doc) {
  const state = getRoomState(roomId);
  if (!state || !doc) return;

  if (!state.awarenessBound) {
    state.awarenessBound = true;

    // Accumulated, never read at eviction: awareness is cleared as sockets close,
    // so by the time a room dies "who was here" is unrecoverable.
    doc.awareness.on("update", ({ added, updated }) => {
      const current = getRoomState(roomId);
      if (!current || current.participants.size >= MAX_PARTICIPANTS) return;

      // Fires on every cursor move: walk only the changed clientIDs, not all states.
      const stateMap = doc.awareness.getStates();
      for (const clientID of added.concat(updated)) {
        const user = stateMap.get(clientID)?.user;
        if (!user || typeof user !== "object") continue;

        const first = sanitizeName(user.firstName);
        const last = sanitizeName(user.lastName);
        const name = sanitizeName(user.name) || [first, last].filter(Boolean).join(" ");
        if (!name) continue;

        // INVARIANT: peer-supplied colour — a non-hex value would reach an inline style.
        const color =
          typeof user.color === "string" && HEX_COLOR.test(user.color)
            ? user.color
            : FALLBACK_COLOR;

        // Keyed on name|color, never clientID: a refresh mints a fresh clientID.
        const key = `${name.toLowerCase()}|${color.toLowerCase()}`;
        if (current.participants.has(key)) continue;
        if (current.participants.size >= MAX_PARTICIPANTS) break;
        current.participants.set(key, { name, color });
      }
    });
  }

  if (!state.updateBound) {
    state.updateBound = true;

    // INVARIANT: doc.on("update"), not a Y.Text observer — only the Doc event carries
    // the sending socket as origin, and Y.Text handlers outlive doc.destroy().
    doc.on("update", (_update, origin) => {
      const current = getRoomState(roomId);
      if (!current) return;

      const userId = current.connUsers.get(origin);
      if (!userId) {
        // A guest, or a token still in flight; beginMemberSession claims it later.
        if (origin && current.pendingEdits.size < MAX_PENDING_EDITS) {
          current.pendingEdits.add(origin);
        }
        return;
      }

      const member = current.members.get(userId);
      if (member) member.didEdit = true;
    });
  }
}

/** Clerk user IDs that earned a `dead_room_members` row (tasks.md §6.1). */
function qualifyingMembers(state, now) {
  const userIds = [];
  state.members.forEach((member, userId) => {
    if (elapsedMs(member, now) >= MEMBER_MIN_CONNECTED_MS && member.didEdit) {
      userIds.push(userId);
    }
  });
  return userIds;
}

// Largest index <= limit that is a UTF-8 character boundary.
// INVARIANT: decoding a buffer cut mid-sequence substitutes U+FFFD, which is THREE bytes and can
// replace a one- or two-byte partial - so `subarray(0, room).toString()` could come back *over*
// budget (measured: 262145 for a 262144 cap, cutting through emoji). Backing off to a boundary
// keeps the cap honest and emits no replacement character at all.
function utf8CutEnd(buf, limit) {
  const end = Math.min(limit, buf.byteLength);
  if (end >= buf.byteLength) return end;

  let i = end;
  while (i > 0 && (buf[i] & 0xc0) === 0x80) i--;
  const lead = buf[i];
  const width = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  // The character starting at i occupies i..i+width-1; keep it only if it ends before the cut.
  return i + width <= end ? end : i;
}

// INVARIANT: strip on every path, and cut through Buffer rather than a byte index
// into the string - a halved surrogate pair fails the whole INSERT.
function snapshotText(yText, budgetBytes = MAX_SNAPSHOT_BYTES) {
  const raw = stripUnstorable(yText.toString());
  const buf = Buffer.from(raw, "utf8");
  if (buf.byteLength <= budgetBytes) return raw;

  const room = Math.max(0, budgetBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  return buf.subarray(0, utf8CutEnd(buf, room)).toString("utf8") + TRUNCATION_MARKER;
}

// Peer-supplied; == `sanitizeFileName` in web/src/lib/collab/roomFiles.ts. The
// path-separator strip matters most: /profile hands this to an `<a download>`.
function sanitizeSnapshotFileName(raw, language) {
  const cleaned =
    typeof raw === "string"
      ? stripUnstorable(raw)
          .replace(/[\u0000-\u001F\u007F]/g, "")
          .replace(/[/\\]/g, "")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  const cut = [...cleaned].slice(0, MAX_FILENAME_LENGTH).join("").trim();
  // "." and ".." survive every replacement above.
  return /[^.]/.test(cut) ? cut : `untitled.${language === "java" ? "java" : "txt"}`;
}

// One shared 256 KB budget across all files, filled in tab order (createdAt then id,
// as `readRoomFiles` derives it) so the entry file is the last thing cut.
function snapshotFiles(doc, language) {
  const filesMap = doc.getMap(FILES_MAP_NAME);

  const entries = [];
  filesMap.forEach((meta, id) => {
    if (typeof id !== "string" || !meta || typeof meta !== "object") return;
    entries.push({
      id,
      name: sanitizeSnapshotFileName(meta.name, language),
      createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : 0,
    });
  });

  // Pre-§10.1 room, or one destroyed before its first sync ever seeded a file.
  if (entries.length === 0) {
    return [
      {
        filename: defaultFileName(language),
        content: snapshotText(doc.getText(LEGACY_TEXT_NAME)),
      },
    ];
  }

  entries.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let remaining = MAX_SNAPSHOT_BYTES;
  const files = [];
  for (const entry of entries.slice(0, MAX_FILES)) {
    const content =
      remaining > 0
        ? snapshotText(doc.getText(FILE_TEXT_PREFIX + entry.id), remaining)
        : TRUNCATION_MARKER;
    remaining -= Buffer.byteLength(content, "utf8");
    files.push({ filename: entry.name, content });
  }
  return files;
}

/** The snapshot, or null when nothing is written — a guest-only room, the common case. */
function buildSnapshot(roomId, doc, now) {
  const state = getRoomState(roomId);
  if (!state) return null;

  const userIds = qualifyingMembers(state, now);
  if (userIds.length === 0) return null;

  const language = state.language ?? DEFAULT_LANGUAGE;

  return {
    roomId,
    userIds,
    files: snapshotFiles(doc, language),
    language,
    isPrivate: false, // until §10.3 adds room passwords
    participants: state.participants.size > 0 ? [...state.participants.values()] : null,
    // INVARIANT: created_at is NOT NULL in the migration — no path may pass null.
    createdAt: new Date(state.createdAt ?? now),
    // The moment the room died, not the INSERT's now(): /profile sorts on and renders it.
    diedAt: new Date(now),
    // Pacing key for server/src/storage/snapshotQueue.js; the roomId fallback is never paced.
    creatorKey: state.creatorKey ?? roomId,
  };
}

function getRoomLanguage(roomId) {
  return states.get(roomId)?.language ?? null;
}

module.exports = {
  MEMBER_MIN_CONNECTED_MS,
  MAX_SNAPSHOT_BYTES,
  ROOM_LANGUAGES,
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  getRoomLanguage,
  createRoomState,
  getRoomState,
  deleteRoomState,
  beginMemberSession,
  endMemberSession,
  forgetConn,
  bindRoomObservers,
  buildSnapshot,
};
