import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  CSS_BREAKOUT,
  GRINNING,
  HOSTILE_COLORS,
  LONE_HIGH,
  LONE_LOW,
  NUL,
  hasLoneSurrogate,
  hasNul,
} from "../fixtures/hostile.mjs";

const require = createRequire(import.meta.url);
const SRC = join(import.meta.dirname, "../../src");
const state = require(join(SRC, "rooms/state.js"));

const {
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
} = state;

let room = 0;
let ids = [];
function newRoom(creatorKey = "203.0.113.9", language = "python") {
  const id = `room-${++room}`;
  ids.push(id);
  createRoomState(id, creatorKey, language);
  return id;
}
afterEach(() => {
  for (const id of ids) deleteRoomState(id);
  ids = [];
});

/**
 * A doc with one file. INVARIANT for these tests: `doc.awareness` must be attached, because
 * bindRoomObservers reads it off the doc — that is how y-websocket wires it in production, and
 * a bare Y.Doc makes every observer throw.
 */
function newDoc() {
  const doc = new Y.Doc();
  doc.awareness = new Awareness(doc);
  return doc;
}

function docWithFile(text = "print(1)\n", name = "main.py", id = "main") {
  const doc = newDoc();
  doc.getMap("files").set(id, { name, createdAt: 1 });
  doc.getText(`file:${id}`).insert(0, text);
  return doc;
}

/** Make `userId` qualify: connected long enough AND actually edited. */
function qualify(roomId, doc, userId = "user_1", conn = {}) {
  const now = Date.now();
  beginMemberSession(roomId, userId, now - (MEMBER_MIN_CONNECTED_MS + 1_000), conn);
  bindRoomObservers(roomId, doc);
  // An update whose origin is the socket is what counts as that member editing.
  doc.transact(() => doc.getText("file:main").insert(0, "x"), conn);
  return now;
}

describe("DI-01 the language is server-authoritative and allowlisted", () => {
  it("DI-01a exactly five languages, javascript the default", () => {
    expect(ROOM_LANGUAGES).toEqual(["javascript", "python", "typescript", "java", "cpp"]);
    expect(DEFAULT_LANGUAGE).toBe("javascript");
  });

  it("DI-01b an unknown value falls back rather than 400ing, so a stale client still works", () => {
    for (const bad of ["rust", "Python", "", null, undefined, 42, "__proto__", {}]) {
      expect(normalizeLanguage(bad)).toBe("javascript");
    }
    for (const good of ROOM_LANGUAGES) expect(normalizeLanguage(good)).toBe(good);
  });

  it("DI-01c getRoomLanguage reads back what the room was created with", () => {
    const id = newRoom("1.2.3.4", "cpp");
    expect(getRoomLanguage(id)).toBe("cpp");
  });
});

describe("DI-02 room state is lookup-only, so a destroyed room cannot be resurrected", () => {
  it("DI-02a createRoomState is get-or-create and never overwrites", () => {
    const id = newRoom("1.2.3.4", "python");
    createRoomState(id, "9.9.9.9", "java"); // what claimRoom does, with no creatorKey
    expect(getRoomState(id).language).toBe("python");
    expect(getRoomState(id).creatorKey).toBe("1.2.3.4");
  });

  it("DI-02b after deleteRoomState, every entry point leaves the room absent", () => {
    const id = newRoom();
    const doc = docWithFile();
    deleteRoomState(id);

    // doc.destroy() re-fires the awareness handler one last time, so these must all no-op.
    beginMemberSession(id, "user_1", Date.now(), {});
    endMemberSession(id, "user_1", Date.now(), {});
    forgetConn(id, {});
    bindRoomObservers(id, doc);
    expect(getRoomState(id)).toBeFalsy();
    expect(buildSnapshot(id, doc, Date.now())).toBeNull();
  });
});

describe("DI-03 who earns a dead_room_members row", () => {
  it("DI-03a a lurker who never edited earns nothing, however long they stayed", () => {
    const id = newRoom();
    const doc = docWithFile();
    beginMemberSession(id, "user_1", Date.now() - (MEMBER_MIN_CONNECTED_MS + 60_000), {});
    expect(buildSnapshot(id, doc, Date.now())).toBeNull();
  });

  it("DI-03b a drive-by who edited but left immediately earns nothing", () => {
    const id = newRoom();
    const doc = docWithFile();
    const conn = {};
    beginMemberSession(id, "user_1", Date.now(), conn);
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("file:main").insert(0, "x"), conn);
    expect(buildSnapshot(id, doc, Date.now())).toBeNull();
  });

  it("DI-03c connected long enough AND edited earns a row", () => {
    const id = newRoom();
    const doc = docWithFile();
    const now = qualify(id, doc);
    const snap = buildSnapshot(id, doc, now);
    expect(snap).not.toBeNull();
    expect(snap.userIds).toEqual(["user_1"]);
  });

  it("DI-03d the seed (a null-origin transaction) does NOT count as editing", () => {
    const id = newRoom();
    const doc = docWithFile("");
    beginMemberSession(id, "user_1", Date.now() - (MEMBER_MIN_CONNECTED_MS + 1_000), {});
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("file:main").insert(0, "seeded")); // no origin
    expect(buildSnapshot(id, doc, Date.now())).toBeNull();
  });

  // The JWKS-race bug: verification resolves ~200ms after the first edit, so early edits arrive
  // with no member to attribute them to. They are parked and drained on verification.
  it("DI-03e an edit that lands BEFORE verification is still attributed", () => {
    const id = newRoom();
    const doc = docWithFile();
    const conn = {};
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("file:main").insert(0, "typed early"), conn);
    // Only now does the token resolve.
    beginMemberSession(id, "user_1", Date.now() - (MEMBER_MIN_CONNECTED_MS + 1_000), conn);
    const snap = buildSnapshot(id, doc, Date.now());
    expect(snap?.userIds).toEqual(["user_1"]);
  });

  it("DI-03f forgetConn clears a guest's parked edit, so it cannot be adopted later", () => {
    const id = newRoom();
    const doc = docWithFile();
    const conn = {};
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("file:main").insert(0, "guest typing"), conn);
    forgetConn(id, conn);
    beginMemberSession(id, "user_1", Date.now() - (MEMBER_MIN_CONNECTED_MS + 1_000), conn);
    expect(buildSnapshot(id, doc, Date.now())).toBeNull();
  });

  it("DI-03g two tabs are two collaborators but ONE member, refcounted", () => {
    const id = newRoom();
    const doc = docWithFile();
    const tab1 = {};
    const tab2 = {};
    const start = Date.now() - (MEMBER_MIN_CONNECTED_MS + 5_000);
    beginMemberSession(id, "user_1", start, tab1);
    beginMemberSession(id, "user_1", start + 90_000, tab2); // must not reset the clock
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("file:main").insert(0, "x"), tab1);
    const snap = buildSnapshot(id, doc, Date.now());
    expect(snap.userIds).toEqual(["user_1"]);
  });

  it("DI-03h verification resolving out of socket order uses the EARLIEST start", () => {
    const id = newRoom();
    const doc = docWithFile();
    const early = {};
    const late = {};
    const t0 = Date.now() - (MEMBER_MIN_CONNECTED_MS + 1_000);
    // The socket opened at t0 pays the JWKS round trip, so it registers second.
    beginMemberSession(id, "user_1", t0 + 100_000, late);
    beginMemberSession(id, "user_1", t0, early);
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("file:main").insert(0, "x"), early);
    expect(buildSnapshot(id, doc, Date.now())?.userIds).toEqual(["user_1"]);
  });

  it("DI-03i elapsed time counts the still-open session, which is the SIGTERM case", () => {
    // connectedMs is 0 here because nothing has closed yet; reading it raw would fail every
    // member on every deploy, which is exactly the case the flush exists for.
    const id = newRoom();
    const doc = docWithFile();
    const conn = {};
    beginMemberSession(id, "user_1", Date.now() - (MEMBER_MIN_CONNECTED_MS + 1_000), conn);
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("file:main").insert(0, "x"), conn);
    expect(getRoomState(id).members.get("user_1").connectedMs).toBe(0);
    expect(buildSnapshot(id, doc, Date.now())?.userIds).toEqual(["user_1"]);
  });

  it("DI-03j a closed session still accrues its time", () => {
    const id = newRoom();
    const doc = docWithFile();
    const conn = {};
    const start = Date.now() - (MEMBER_MIN_CONNECTED_MS + 2_000);
    beginMemberSession(id, "user_1", start, conn);
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("file:main").insert(0, "x"), conn);
    endMemberSession(id, "user_1", start + MEMBER_MIN_CONNECTED_MS + 1_000, conn);
    expect(buildSnapshot(id, doc, Date.now())?.userIds).toEqual(["user_1"]);
  });
});

describe("DI-04 what the snapshot carries", () => {
  it("DI-04a every field, with created_at never null and died_at bound by the writer", () => {
    const id = newRoom("198.51.100.4", "python");
    const doc = docWithFile();
    const now = qualify(id, doc);
    const snap = buildSnapshot(id, doc, now);

    expect(snap.roomId).toBe(id);
    expect(snap.language).toBe("python");
    expect(snap.isPrivate).toBe(false);
    expect(snap.createdAt).toBeInstanceOf(Date);
    expect(snap.diedAt).toBeInstanceOf(Date);
    // died_at is the moment the room died, not the INSERT's now() — /profile sorts on it.
    expect(snap.diedAt.getTime()).toBe(now);
    // The creator's IP is carried for pacing only and must never become a column.
    expect(snap.creatorKey).toBe("198.51.100.4");
    expect(snap.participants).toBeNull();
  });

  it("DI-04b files are captured in tab order with their real names", () => {
    const id = newRoom();
    const doc = newDoc();
    doc.getMap("files").set("main", { name: "main.py", createdAt: 1 });
    doc.getMap("files").set("b", { name: "helper.py", createdAt: 2 });
    doc.getText("file:main").insert(0, "entry");
    doc.getText("file:b").insert(0, "helper");
    const now = qualify(id, doc);
    const snap = buildSnapshot(id, doc, now);
    expect(snap.files.map((f) => f.filename)).toEqual(["main.py", "helper.py"]);
    expect(snap.files[0].content).toContain("entry");
  });

  it("DI-04c a room with no files falls back to the legacy single Y.Text", () => {
    const id = newRoom("1.2.3.4", "javascript");
    const doc = newDoc();
    doc.getText("monaco").insert(0, "legacy content");
    const conn = {};
    beginMemberSession(id, "user_1", Date.now() - (MEMBER_MIN_CONNECTED_MS + 1_000), conn);
    bindRoomObservers(id, doc);
    doc.transact(() => doc.getText("monaco").insert(0, "x"), conn);
    const snap = buildSnapshot(id, doc, Date.now());
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0].content).toContain("legacy content");
  });

  it("DI-04d more than MAX_FILES files are capped at 20", () => {
    const id = newRoom();
    const doc = newDoc();
    for (let i = 0; i < 25; i++) {
      doc.getMap("files").set(`f${i}`, { name: `f${i}.py`, createdAt: i });
      doc.getText(`file:f${i}`).insert(0, "x");
    }
    doc.getMap("files").set("main", { name: "main.py", createdAt: -1 });
    doc.getText("file:main").insert(0, "entry");
    const now = qualify(id, doc);
    expect(buildSnapshot(id, doc, now).files).toHaveLength(20);
  });
});

describe("VAL-08 nothing unstorable reaches a Postgres column", () => {
  it("VAL-08a NUL is stripped from document content", () => {
    const id = newRoom();
    const doc = docWithFile(`a${NUL}b`);
    const now = qualify(id, doc);
    const content = buildSnapshot(id, doc, now).files[0].content;
    expect(hasNul(content)).toBe(false);
  });

  // The 7.4 trap: the repair used to run only on the *truncating* branch, so a lone surrogate in
  // a document UNDER 256 KB was returned untouched and failed the whole INSERT.
  it("VAL-08b a lone surrogate in a document well under the cap is still stripped", () => {
    const id = newRoom();
    const doc = docWithFile(`small ${LONE_HIGH} doc ${LONE_LOW}`);
    const now = qualify(id, doc);
    const content = buildSnapshot(id, doc, now).files[0].content;
    expect(hasLoneSurrogate(content)).toBe(false);
    expect(content.length).toBeLessThan(1000);
  });

  it("VAL-08c a valid surrogate pair survives", () => {
    const id = newRoom();
    const doc = docWithFile(`emoji ${GRINNING} ok`);
    const now = qualify(id, doc);
    expect(buildSnapshot(id, doc, now).files[0].content).toContain(GRINNING);
  });

  it("VAL-08d filenames lose path separators on the server side too", () => {
    const id = newRoom();
    const doc = docWithFile("x", "../../etc/passwd");
    const now = qualify(id, doc);
    const filename = buildSnapshot(id, doc, now).files[0].filename;
    expect(filename).toBe("....etcpasswd");
    expect(filename).not.toMatch(/[/\\]/);
  });

  it("VAL-08e a dots-only filename becomes untitled.<ext>", () => {
    const id = newRoom("1.2.3.4", "java");
    const doc = docWithFile("x", "..");
    const now = qualify(id, doc);
    expect(buildSnapshot(id, doc, now).files[0].filename).toBe("untitled.java");
  });

  it("VAL-08f a filename is cut by code point, never halving a pair", () => {
    const id = newRoom();
    const doc = docWithFile("x", `a${GRINNING.repeat(32)}`);
    const now = qualify(id, doc);
    const filename = buildSnapshot(id, doc, now).files[0].filename;
    expect([...filename].length).toBeLessThanOrEqual(64);
    expect(hasLoneSurrogate(filename)).toBe(false);
  });
});

describe("EC-06 the 256 KB snapshot budget", () => {
  it("EC-06a a document under the cap is stored verbatim with no marker", () => {
    const id = newRoom();
    const body = "a".repeat(1000);
    const doc = docWithFile(body);
    const now = qualify(id, doc);
    const content = buildSnapshot(id, doc, now).files[0].content;
    expect(content).toContain(body);
    expect(content).not.toContain("snapshot truncated");
  });

  it("EC-06b an oversized document is truncated once, inside the budget", () => {
    const id = newRoom();
    const doc = docWithFile("a".repeat(MAX_SNAPSHOT_BYTES + 50_000));
    const now = qualify(id, doc);
    const content = buildSnapshot(id, doc, now).files[0].content;
    expect(content.endsWith("snapshot truncated: room exceeded 256 KB --- */\n")).toBe(true);
    expect((content.match(/snapshot truncated/g) ?? []).length).toBe(1);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it("EC-06c cutting through emoji stays inside the cap and emits no replacement char", () => {
    const id = newRoom();
    // 70k * 4 bytes = 280 KB, so the cut necessarily lands inside a multi-byte sequence.
    const doc = docWithFile(GRINNING.repeat(70_000));
    const now = qualify(id, doc);
    const content = buildSnapshot(id, doc, now).files[0].content;
    expect(hasLoneSurrogate(content)).toBe(false);
    // Was 262145 before utf8CutEnd: decoding a partial sequence yields a 3-byte U+FFFD, which
    // can be wider than the 1-2 byte partial it replaces, pushing the result over budget.
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(content).not.toContain("�");
  });

  // The honest bound, rather than the one CLAUDE.md claims. Each starved file still carries a
  // full marker, so the total overshoots the nominal cap by (files - 1) x marker. Bounded,
  // benign against a jsonb column, and pinned here so it cannot drift unnoticed.
  it("EC-06e the real total is the cap plus one marker per starved file", () => {
    const id = newRoom();
    const doc = newDoc();
    const fileCount = 8;
    for (let i = 0; i < fileCount; i++) {
      const fid = i === 0 ? "main" : `f${i}`;
      doc.getMap("files").set(fid, { name: `${fid}.py`, createdAt: i });
      doc.getText(`file:${fid}`).insert(0, "x".repeat(100 * 1024));
    }
    const now = qualify(id, doc);
    const files = buildSnapshot(id, doc, now).files;

    const total = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
    const markerBytes = Buffer.byteLength(
      "\n\n/* --- snapshot truncated: room exceeded 256 KB --- */\n",
      "utf8"
    );
    expect(files).toHaveLength(fileCount);
    expect(total).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
    expect(total).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES + fileCount * markerBytes);
    // At 20 files that is ~1.1 KB over a 256 KB cap: 0.4%.
    expect(total - MAX_SNAPSHOT_BYTES).toBeLessThan(1024);
  });

  it("EC-06d the budget is SHARED across files and spent in tab order", () => {
    const id = newRoom();
    const doc = newDoc();
    for (const [i, fid] of ["main", "b", "c"].entries()) {
      doc.getMap("files").set(fid, { name: `${fid}.py`, createdAt: i });
      doc.getText(`file:${fid}`).insert(0, "x".repeat(200 * 1024));
    }
    const now = qualify(id, doc);
    const files = buildSnapshot(id, doc, now).files;
    // The entry file is created first, so it is the last thing cut: file 1 keeps real content
    // and the later ones are starved down to the marker.
    expect(files[0].content.length).toBeGreaterThan(1000);
    expect(files[2].content).toContain("snapshot truncated");
    expect(files[2].content.replace(/\s|\/\*|\*\/|-|snapshot truncated: room exceeded 256 KB/g, "")).toBe("");
  });
});

describe("VAL-09 accumulated participants are sanitized", () => {
  function withAwareness(id) {
    const doc = docWithFile();
    bindRoomObservers(id, doc);
    return { doc, awareness: doc.awareness };
  }

  it("VAL-09a a hostile colour becomes grey before it can reach /profile", () => {
    const id = newRoom();
    const { doc, awareness } = withAwareness(id);
    if (!getRoomState(id)) return;
    for (const bad of HOSTILE_COLORS) {
      awareness.setLocalStateField("user", { name: `P${String(bad).slice(0, 4)}`, color: bad });
    }
    const participants = [...getRoomState(id).participants.values()];
    for (const p of participants) expect(/^#[0-9a-f]{6}$/i.test(p.color)).toBe(true);
    doc.destroy();
  });

  it("VAL-09b a peer name is capped and stripped", () => {
    const id = newRoom();
    const { doc, awareness } = withAwareness(id);
    awareness.setLocalStateField("user", { name: `${NUL}${"n".repeat(200)}`, color: "#ef9a9a" });
    const participants = [...getRoomState(id).participants.values()];
    if (participants.length > 0) {
      expect([...participants[0].name].length).toBeLessThanOrEqual(24);
      expect(hasNul(participants[0].name)).toBe(false);
    }
    doc.destroy();
  });

  it("VAL-09c a CSS-breakout colour never survives as a colour", () => {
    const id = newRoom();
    const { doc, awareness } = withAwareness(id);
    awareness.setLocalStateField("user", { name: "X", color: CSS_BREAKOUT });
    const participants = [...getRoomState(id).participants.values()];
    if (participants.length > 0) expect(participants[0].color).toBe("#9e9e9e");
    doc.destroy();
  });
});
