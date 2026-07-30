// What a room was, as opposed to whether it exists.
//
// `server/src/rooms/lifecycle.js` answers one question — does this room exist — and answered it with
// nothing but two maps of timers. Task 7.3 needs four things it never recorded:
// when the room was created, which *verified* Clerk users were in it, how long
// each stayed, and whether they actually edited anything. That bookkeeping lives
// here so `server/src/rooms/lifecycle.js` keeps its single, narrow job.
//
// ---------------------------------------------------------------------------
// HARD RULE: every function here is lookup-only. Nothing may create room state
// as a side effect of an observer.
//
// `doc.destroy()` synchronously re-fires the awareness `update` handler one last
// time. y-protocols registers `doc.on('destroy', () => this.destroy())`, and
// `Awareness.destroy()` is:
//
//     destroy () {
//       this.emit('destroy', [this])
//       this.setLocalState(null)   // <- emits 'update' with removed:[clientID]
//       super.destroy()            // <- only NOW are our listeners dropped
//       clearInterval(this._checkInterval)
//     }
//
// So a get-or-create inside that handler would resurrect the entry for a room
// that was just destroyed, and nothing would ever delete it again: one leaked
// entry per dead room, forever. Handlers call `getRoomState()` and bail on null.
// ---------------------------------------------------------------------------

// tasks.md §6.1 asks for "more than a trivial moment". Its prose suggests the
// grace window (10s), but its own scenario table says a signed-in stranger who
// lurks 30s gets nothing — 10s cannot deliver that, so the table wins. Paired
// with `didEdit` below, which is what actually kills the lurker case: 60s alone
// is passed by anyone who leaves a tab open.
const MEMBER_MIN_CONNECTED_MS = Number(process.env.MEMBER_MIN_CONNECTED_MS) || 60_000;

// A snapshot is the one new unbounded write v2 adds: MAX_CODE_BYTES caps what is
// *sent to Piston*, but nothing bounds how large a room's Y.Text grows. 256 KB is
// 4x that cap, so no runnable program trips this.
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const TRUNCATION_MARKER = "\n\n/* --- snapshot truncated: room exceeded 256 KB --- */\n";

// Both are ceilings on peer-supplied data accumulated over a room's life, and a
// room can live for hours.
const MAX_MEMBERS = 200;
const MAX_PARTICIPANTS = 50;
// Sockets awaiting attribution. Bounded by concurrent connections in practice;
// the cap only matters if `forgetConn` were ever missed.
const MAX_PENDING_EDITS = 500;

// The third copy of these rules, after server/src/http/rateLimit.js mirroring
// web/src/lib/sandbox/rateLimit.ts and CLOSE_ROOM_NOT_FOUND living in two files. The two
// workspaces share no code and this one has no build step, so importing
// web/src/lib/collab/user.ts and web/src/lib/collab/awareness.ts is not an option — but the values must
// stay in step by hand.
const MAX_NAME_LENGTH = 24; // == web/src/lib/collab/user.ts
const HEX_COLOR = /^#[0-9a-f]{6}$/i; // == web/src/lib/collab/awareness.ts
const FALLBACK_COLOR = "#9e9e9e"; // == web/src/lib/collab/awareness.ts

// ── Multi-file rooms (tasks.md §10.1) ──────────────────────────────────────
// The shared-document names, mirroring web/src/lib/collab/roomFiles.ts. This server never
// writes them — it only reads the room's final state at the moment it dies.
const FILES_MAP_NAME = "files";
const FILE_TEXT_PREFIX = "file:";
// Pre-§10.1 rooms kept their whole contents in this one Y.Text. Nothing creates
// one any more, but the fallback in `snapshotFiles` costs a branch and the
// alternative is a silently empty snapshot.
const LEGACY_TEXT_NAME = "monaco";
const MAX_FILES = 20; // == web/src/lib/collab/roomFiles.ts
const MAX_FILENAME_LENGTH = 64; // == web/src/lib/collab/roomFiles.ts

// The **sixth** hand-maintained cross-workspace duplication, after
// rateLimit.js/rateLimit.ts, CLOSE_ROOM_NOT_FOUND, sanitizeName/HEX_COLOR above,
// TRUNCATION_MARKER and MEMBER_MIN_CONNECTED_MS. It is the `value` column of
// LANGUAGES in web/src/lib/editor/languages.ts.
//
// An allowlist rather than "store whatever arrived": `POST /rooms?language=` is
// an anonymous, unauthenticated endpoint, and this value is written to
// `dead_rooms.language` and rendered on /profile. Five known strings cost
// nothing to check and mean nothing arbitrary can ever reach the column.
const ROOM_LANGUAGES = ["javascript", "python", "typescript", "java", "cpp"];
const DEFAULT_LANGUAGE = "javascript"; // == web/src/lib/editor/languages.ts

// Only used to name a fallback file — a room that died before its first sync
// seeded one, or a pre-§10.1 room. Every file a client actually created carries
// its own name. == `ext` in web/src/lib/editor/languages.ts.
const LANGUAGE_EXT = {
  javascript: "js",
  python: "py",
  typescript: "ts",
  java: "java",
  cpp: "cpp",
};

/** `Main.java` / `main.py`, matching `downloadFileName` in web/src/lib/editor/languages.ts. */
function defaultFileName(language) {
  if (language === "java") return "Main.java";
  return `main.${LANGUAGE_EXT[language] ?? "txt"}`;
}

/** Narrows the `?language=` query parameter. Anything unknown is the default. */
function normalizeLanguage(raw) {
  return ROOM_LANGUAGES.includes(raw) ? raw : DEFAULT_LANGUAGE;
}

/**
 * Characters that cannot survive the trip into Postgres, and take the whole
 * snapshot with them if they try.
 *
 *  - **NUL** cannot be stored in a `text` or `jsonb` value at all.
 *  - An **unpaired surrogate** is worse, because it fails loudly and late:
 *    `JSON.stringify` happily emits `"\ud83d"`, and Postgres rejects the entire
 *    statement with `unsupported Unicode escape sequence`. One bad character in
 *    one participant's name therefore loses the room's code as well.
 *
 * Both are stripped from *everything* that reaches a column. Neither is typeable
 * in Monaco, but both are trivially reachable: awareness is peer-supplied (a
 * client sets its own `user.name`), and a paste or a raw Yjs client can put
 * either into the document. `snapshotText` used to be protected only on its
 * truncation branch, where `Buffer.toString("utf8")` substitutes U+FFFD — so a
 * document *under* the cap skipped the guard entirely.
 */
const UNSTORABLE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Drops anything Postgres cannot store. See {@link UNSTORABLE}. */
function stripUnstorable(raw) {
  return raw.replace(UNSTORABLE, "");
}

/**
 * roomId -> room state. Only `createRoomState` ever adds a key.
 *
 * @typedef {{
 *   connectedMs: number,
 *   openCount: number,
 *   sessionStartedAt: number,
 *   lastActiveAt: number,
 *   didEdit: boolean,
 * }} Member
 *
 * @type {Map<string, {
 *   createdAt: number,
 *   creatorKey: string | null,
 *   language: string,
 *   members: Map<string, Member>,
 *   participants: Map<string, {name: string, color: string}>,
 *   connUsers: Map<object, string>,
 *   updateBound: boolean,
 *   awarenessBound: boolean,
 * }>}
 */
const states = new Map();

/**
 * Called from `reserveRoom` — this is the only thing that knows `created_at`.
 *
 * Get-or-create, and that matters now that it takes a second argument:
 * `claimRoom` also calls it, defensively and with no `creatorKey`, so returning
 * the existing state untouched is what stops the first connection erasing the
 * key `POST /rooms` recorded. Do not "simplify" this into an unconditional
 * overwrite.
 *
 * `creatorKey` is the creating caller's IP (task 7.5's pacing key). It lives
 * only here, dies with the room, and is never written to Postgres — see
 * `server/src/storage/db.js`'s `saveDeadRoom`.
 *
 * `language` (task §10.1) is the same story with the opposite ending: also
 * recorded once, at `POST /rooms`, because that is the only moment anyone states
 * it — but this one *is* written, and is what finally gives `dead_rooms.language`
 * a value. It is normalized here rather than at the route so there is one place
 * that decides what a room's language may be.
 */
function createRoomState(roomId, creatorKey = null, language = null) {
  const existing = states.get(roomId);
  if (existing) return existing;

  const state = {
    createdAt: Date.now(),
    creatorKey,
    language: normalizeLanguage(language),
    members: new Map(),
    participants: new Map(),
    // Socket -> verified user ID. Needed because Yjs hands us the *socket* as a
    // transaction origin, which is how `didEdit` is attributed at all.
    connUsers: new Map(),
    // Sockets that edited *before* their token finished verifying.
    //
    // Verification is asynchronous and the first call of the process fetches
    // Clerk's JWKS (~200ms measured), while a client syncs and starts typing in
    // ~50ms. Without this, every edit in that window is attributed to nobody and
    // the user fails the `didEdit` half of the threshold — silently losing their
    // snapshot. It reproduced consistently for the first signed-in user after a
    // restart, and disappeared for every user after, because the JWKS cache then
    // wins the race. Drained by `beginMemberSession`.
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

/**
 * Total time a member has been connected, including any session still open.
 *
 * The one accessor: never read `connectedMs` directly. At the SIGTERM flush every
 * member is still connected, so `connectedMs` is missing the entire live session
 * — reading it raw would fail every member on every deploy, which is exactly the
 * case the shutdown flush exists to save.
 */
function elapsedMs(member, now) {
  return member.connectedMs + (member.openCount > 0 ? now - member.sessionStartedAt : 0);
}

/**
 * A verified user opened a socket on this room. Reference-counted: one user can
 * hold several sockets (two tabs, or a reconnect overlapping its predecessor).
 */
function beginMemberSession(roomId, userId, at, conn) {
  const state = getRoomState(roomId);
  if (!state) return; // room already destroyed

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

  // Only on the 0 -> 1 transition, or a second tab opening at t=90s would reset
  // the clock and the user would never reach the threshold while both stay open.
  //
  // Math.min because verification resolves out of socket order: the first
  // connection of the process pays a JWKS round trip (~200-800ms) and later ones
  // hit the cache, so a socket opened at t=0 can land here *after* one opened at
  // t=100ms. Without the min, the earlier connect time is silently discarded.
  member.sessionStartedAt =
    member.openCount === 0 ? at : Math.min(member.sessionStartedAt, at);
  member.openCount += 1;

  if (conn) {
    state.connUsers.set(conn, userId);
    // Claim anything this socket wrote while its token was still being verified.
    if (state.pendingEdits.delete(conn)) member.didEdit = true;
  }
}

/**
 * Drops a socket's unattributed-edit record. Called for *every* closing socket,
 * verified or not — a guest's entry would otherwise sit in `pendingEdits` for
 * the room's whole life, and a room can outlive many joins and leaves.
 */
function forgetConn(roomId, conn) {
  const state = getRoomState(roomId);
  if (state) state.pendingEdits.delete(conn);
}

/**
 * One of that user's sockets closed. Callers must guarantee this runs at most
 * once per socket — see the `ended` flag in sync/connection.js. A double decrement
 * strands `openCount` below zero, the `=== 0` branch never fires again, and that
 * user's time stops accruing for the rest of the room's life.
 */
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

/**
 * Names end up rendered on /profile, so they get the same treatment as any peer name.
 *
 * The cut is by **code point**, not `String.prototype.slice`. A 24-code-*unit*
 * slice can land in the middle of a surrogate pair, so a name with an emoji
 * straddling that boundary would leave a lone surrogate — and one participant's
 * name would then take the room's entire snapshot down with it (see
 * {@link UNSTORABLE}). `stripUnstorable` covers surrogates that arrive already
 * unpaired; the code-point cut covers the ones this function would create.
 */
function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  const cleaned = stripUnstorable(raw)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, MAX_NAME_LENGTH).join("");
}

/**
 * Binds the two per-room observers. Idempotent — called on every connection, but
 * each handler is registered once per room.
 *
 * Both handlers are lookup-only. See the HARD RULE at the top of this file.
 */
function bindRoomObservers(roomId, doc) {
  const state = getRoomState(roomId);
  if (!state || !doc) return;

  if (!state.awarenessBound) {
    state.awarenessBound = true;

    // Participants have to be *accumulated*, not read at eviction: y-websocket's
    // `closeConn` calls `removeAwarenessStates()` for every socket that closes,
    // so by the time a room is destroyed its awareness is empty. There is no
    // later moment at which "who was here" can be recovered.
    doc.awareness.on("update", ({ added, updated }) => {
      const current = getRoomState(roomId);
      if (!current || current.participants.size >= MAX_PARTICIPANTS) return;

      // This fires on every cursor move of every peer — Monaco emits one per
      // caret change. Walk only the clientIDs the payload says changed; a full
      // `getStates()` rescan would re-walk the participants map on every
      // keystroke of every user in the room.
      const stateMap = doc.awareness.getStates();
      for (const clientID of added.concat(updated)) {
        const user = stateMap.get(clientID)?.user;
        if (!user || typeof user !== "object") continue;

        const first = sanitizeName(user.firstName);
        const last = sanitizeName(user.lastName);
        const name = sanitizeName(user.name) || [first, last].filter(Boolean).join(" ");
        if (!name) continue;

        // Untrusted: a peer sets its own colour, and one that fails HEX_COLOR
        // would reach an inline style on /profile. Same guard as readPeers.
        const color =
          typeof user.color === "string" && HEX_COLOR.test(user.color)
            ? user.color
            : FALLBACK_COLOR;

        // Keyed on name|color, never clientID: a refresh inside the grace window
        // mints a fresh Y.Doc and therefore a fresh clientID, so one person who
        // refreshed twice would otherwise appear three times.
        const key = `${name.toLowerCase()}|${color.toLowerCase()}`;
        if (current.participants.has(key)) continue;
        if (current.participants.size >= MAX_PARTICIPANTS) break;
        current.participants.set(key, { name, color });
      }
    });
  }

  if (!state.updateBound) {
    state.updateBound = true;

    // The contribution threshold's second half. y-websocket's `messageListener`
    // calls `readSyncMessage(decoder, encoder, doc, conn)` — the 4th argument is
    // the transaction origin — so Yjs hands us the exact socket that sent each
    // edit. That is what makes "did this person actually write anything" cost ten
    // lines instead of a new protocol message.
    //
    // Deliberately `doc.on("update")` rather than a Y.Text observer: `Doc.destroy`
    // calls `super.destroy()`, which clears the Doc's own observers, whereas a
    // Y.Text handler survives destruction. The origin is only available here
    // anyway.
    doc.on("update", (_update, origin) => {
      const current = getRoomState(roomId);
      if (!current) return;

      const userId = current.connUsers.get(origin);
      if (!userId) {
        // Either a guest (harmless — nothing ever drains this for them, and
        // `forgetConn` clears it on close) or a signed-in user whose token is
        // still in flight. `beginMemberSession` claims it a moment later.
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

/**
 * The room's text, capped.
 *
 * Two silent corruptions live in this function, and both only reproduce on
 * documents nobody writes by hand:
 *
 *  - NUL and unpaired surrogates cannot reach a Postgres column at all — see
 *    {@link UNSTORABLE}. `stripUnstorable` runs on *every* path, not only the
 *    truncating one: a document under the cap used to be returned raw, so a
 *    lone surrogate in a small file lost the whole snapshot while the very same
 *    character in a 300 KB file was quietly repaired by the Buffer round-trip
 *    below. Monaco types neither, but a paste or a raw Yjs client can carry
 *    both, and Y.Text stores them happily.
 *  - The cut must go through Buffer, not a byte index into the JS string. A
 *    hand-rolled slice can cut a surrogate pair in half; JSON.stringify then
 *    emits a lone "\ud83d" and Postgres rejects the whole INSERT with
 *    "unsupported Unicode escape sequence", losing the snapshot. Node's decoder
 *    substitutes U+FFFD instead. Only reachable with emoji or CJK near the cap.
 */
function snapshotText(yText, budgetBytes = MAX_SNAPSHOT_BYTES) {
  const raw = stripUnstorable(yText.toString());
  const buf = Buffer.from(raw, "utf8");
  if (buf.byteLength <= budgetBytes) return raw;

  const room = Math.max(0, budgetBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  return buf.subarray(0, room).toString("utf8") + TRUNCATION_MARKER;
}

/**
 * A filename safe to store and to render on /profile.
 *
 * The server's copy of `sanitizeFileName` in `web/src/lib/collab/roomFiles.ts` — the client
 * sanitizes what it puts into the shared map, but the map is peer-supplied and a
 * raw Yjs client never runs that code. The path-separator strip is the part that
 * matters most: /profile hands this straight to an `<a download>`.
 */
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
  // "." and ".." survive every replacement above and are not filenames.
  return /[^.]/.test(cut) ? cut : `untitled.${language === "java" ? "java" : "txt"}`;
}

/**
 * The room's files, in tab order, inside one shared 256 KB budget.
 *
 * The cap is per **snapshot**, not per file: it exists to bound the one
 * unbounded write v2 adds, and twenty files of 256 KB each would defeat that
 * entirely. Files are filled in tab order and the one that crosses the boundary
 * is cut, so the entry file — created first, and the one Run executes — is the
 * last thing to be lost. Files past the budget are stored as the marker alone,
 * which /profile already renders as its amber "this room grew past the cap"
 * notice (`isTruncated` matches with `endsWith`).
 *
 * Order is derived exactly as `readRoomFiles` derives it on the client:
 * `createdAt`, tiebroken by id. Nothing on the wire carries an order.
 *
 * The cap is approached from below and then overshot by at most one marker per
 * over-budget file — measured 262201 bytes for 4x100 KB against a 262144 byte
 * cap. Bounded at MAX_FILES x ~57 bytes (~1.1 KB, 0.4%), and deliberately not
 * "fixed": reserving the markers up front would shrink the *real* code every
 * room may keep, to buy exactness in a number that only exists to stop a
 * pathological write.
 */
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

/**
 * Builds the dead-room snapshot, or returns null when there is nothing to write.
 *
 * Ordering is deliberate: the overwhelmingly common case is a fully-guest room,
 * where §6.1 says nothing is written at all. Deciding that *before* calling
 * `toString()` on the Y.Text means the normal path never materialises the
 * document at all.
 *
 * @returns {null | {
 *   roomId: string,
 *   userIds: string[],
 *   files: Array<{filename: string, content: string}>,
 *   language: string,
 *   isPrivate: boolean,
 *   participants: Array<{name: string, color: string}> | null,
 *   createdAt: Date,
 *   diedAt: Date,
 *   creatorKey: string,
 * }}
 */
function buildSnapshot(roomId, doc, now) {
  const state = getRoomState(roomId);
  if (!state) return null;

  const userIds = qualifyingMembers(state, now);
  if (userIds.length === 0) return null;

  const language = state.language ?? DEFAULT_LANGUAGE;

  return {
    roomId,
    userIds,
    // Every file in the room, under its real name, inside one shared 256 KB
    // budget (§10.1). Before it, this was always the single literal `main.txt`,
    // because the language was a per-user editing preference and the server had
    // no room-wide answer to derive an extension from.
    files: snapshotFiles(doc, language),
    // Written for the first time by §10.1: the language is now chosen once at
    // room creation, so `dead_rooms.language` — null on every row written before
    // this — finally has a value, and /profile stops saying "not recorded".
    language,
    isPrivate: false, // until §10.3 adds room passwords
    participants: state.participants.size > 0 ? [...state.participants.values()] : null,
    // `created_at` is NOT NULL in the migration, so no path may pass null here.
    createdAt: new Date(state.createdAt ?? now),
    // The moment the room actually died, captured here rather than left to the
    // INSERT's `now()`: since 7.5 the write can be paced, and /profile both
    // sorts on and renders this value. See db.js's INSERT.
    diedAt: new Date(now),
    // The pacing key for `server/src/storage/snapshotQueue.js`. Falls back to the room ID rather
    // than a shared sentinel: `clientKey()` already returns the literal
    // "unknown" for an unidentifiable caller, so sharing that string would put
    // every unattributable room in one bucket and serialise them behind each
    // other for no reason. A room is written exactly once, so a roomId key can
    // never exceed one hit in its window — an unattributable snapshot is
    // therefore never paced, which is the right answer: you cannot rate-limit a
    // caller you cannot identify, and pretending to only penalises the victim.
    creatorKey: state.creatorKey ?? roomId,
  };
}

/** The room's language, for `GET /rooms/:roomId` (§10.1). Null if unknown. */
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
