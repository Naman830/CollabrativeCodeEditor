import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

const require = createRequire(import.meta.url);
const SRC = join(import.meta.dirname, "../../src");

// No DATABASE_URL: db.isEnabled() is false, so destroyRoom builds no snapshot and this tier
// never touches Postgres.
delete process.env.DATABASE_URL;
delete process.env.CLERK_SECRET_KEY;

const { docs } = require("y-websocket/bin/utils");
const lifecycle = require(join(SRC, "rooms/lifecycle.js"));
const state = require(join(SRC, "rooms/state.js"));
const snapshotQueue = require(join(SRC, "storage/snapshotQueue.js"));

const {
  MAX_RESERVATIONS,
  reserveRoom,
  roomExists,
  claimRoom,
  scheduleEviction,
  destroyRoom,
  beginShutdown,
  isShuttingDown,
} = lifecycle;

/** A doc shaped the way y-websocket makes them: a conns map and attached awareness. */
function liveDoc(roomId, conns = 1) {
  // A null roomId here means reserveRoom hit its ceiling and every assertion below would
  // pass vacuously against a doc keyed on null.
  if (!roomId) throw new Error("liveDoc needs a real room id");
  const doc = new Y.Doc();
  doc.awareness = new Awareness(doc);
  doc.conns = new Map();
  for (let i = 0; i < conns; i++) doc.conns.set({}, new Set());
  doc.getMap("files").set("main", { name: "main.py", createdAt: 1 });
  doc.getText("file:main").insert(0, "print(1)\n");
  docs.set(roomId, doc);
  return doc;
}

const created = [];
afterEach(() => {
  for (const id of [...docs.keys()]) docs.delete(id);
  for (const id of created) state.deleteRoomState(id);
  created.length = 0;
});

describe("LC-01 reservations", () => {
  it("LC-01a a reserved room exists before anyone has connected", () => {
    const id = reserveRoom("1.2.3.4", "python");
    created.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(roomExists(id)).toBe(true);
    // The only place created_at, the creator key and the language are recorded.
    expect(state.getRoomState(id).language).toBe("python");
    expect(state.getRoomState(id).creatorKey).toBe("1.2.3.4");
  });

});

describe("LC-02 claiming and eviction", () => {
  it("LC-02a claimRoom cancels a pending eviction, so a reconnect keeps its doc", async () => {
    const id = reserveRoom("1.2.3.4", "python");
    created.push(id);
    const doc = liveDoc(id, 0);

    scheduleEviction(id);
    claimRoom(id);
    // Give the (short) grace window a chance to fire had it not been cancelled.
    await new Promise((r) => setTimeout(r, 50));
    expect(docs.has(id)).toBe(true);
    expect(doc.isDestroyed).toBeFalsy();
  });

  it("LC-02b scheduleEviction is idempotent", () => {
    const id = reserveRoom("1.2.3.4", "python");
    created.push(id);
    liveDoc(id, 0);
    scheduleEviction(id);
    scheduleEviction(id);
    scheduleEviction(id);
    expect(docs.has(id)).toBe(true);
  });

  it("LC-02c a room with a live connection survives its own eviction timer", async () => {
    // The timer re-checks conns.size when it FIRES, not just on the cancel path.
    process.env.ROOM_GRACE_MS = "1000";
    const path = require.resolve(join(SRC, "rooms/lifecycle.js"));
    delete require.cache[path];
    const fresh = require(path);
    const id = fresh.reserveRoom("1.2.3.4", "python");
    created.push(id);
    liveDoc(id, 1); // someone is still here

    fresh.scheduleEviction(id);
    await new Promise((r) => setTimeout(r, 1_300));
    expect(docs.has(id)).toBe(true);

    delete process.env.ROOM_GRACE_MS;
    delete require.cache[path];
  });
});

describe("LC-03 destroyRoom", () => {
  it("LC-03a deletes from docs SYNCHRONOUSLY, so nobody can rejoin a committed room", () => {
    const id = reserveRoom("1.2.3.4", "python");
    created.push(id);
    liveDoc(id, 0);
    // What a connection does. destroyRoom deletes from `docs` only, so without this the
    // reservation would linger and roomExists() would still answer true.
    claimRoom(id);

    const result = destroyRoom(id, "test");
    // Not a promise: an await before docs.delete() would leave a window in which roomExists()
    // still answers true while the snapshot is already being written.
    expect(result).toBeUndefined();
    expect(docs.has(id)).toBe(false);
    expect(roomExists(id)).toBe(false);
    expect(state.getRoomState(id)).toBeFalsy();
  });

  it("LC-03b is idempotent, which is what makes the eviction/flush race safe", () => {
    const id = reserveRoom("1.2.3.4", "python");
    created.push(id);
    liveDoc(id, 0);
    claimRoom(id);
    destroyRoom(id, "first");
    expect(() => destroyRoom(id, "second")).not.toThrow();
  });

  it("LC-03c a throwing snapshot build still destroys the room and escapes no exception", () => {
    const id = reserveRoom("1.2.3.4", "python");
    created.push(id);
    const doc = liveDoc(id, 0);
    claimRoom(id);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // buildSnapshot is destructured inside lifecycle, so poison the doc instead.
    doc.getMap = () => {
      throw new Error("synthetic");
    };

    expect(() => destroyRoom(id, "test")).not.toThrow();
    expect(docs.has(id)).toBe(false);
    error.mockRestore();
  });
});

describe("LC-04 shutdown ordering", () => {
  it("LC-04a beginShutdown flips the flag without closing anything", () => {
    // This is what makes /health's 503 branch reachable: before it existed, server.close() ran
    // first and the platform got ECONNREFUSED instead of the 503.
    expect(isShuttingDown()).toBe(false);
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
  });

  it("LC-04b once shutting down, no new eviction is scheduled", () => {
    const id = reserveRoom("1.2.3.4", "python");
    created.push(id);
    liveDoc(id, 0);
    beginShutdown();
    expect(() => scheduleEviction(id)).not.toThrow();
    expect(docs.has(id)).toBe(true);
  });

  it("LC-04c the flush releases pacing BEFORE destroying rooms", async () => {
    const path = require.resolve(join(SRC, "rooms/lifecycle.js"));
    delete require.cache[path];
    const fresh = require(path);
    const order = [];
    const release = vi.spyOn(snapshotQueue, "releasePacing").mockImplementation(() => order.push("release"));
    const destroySpy = vi.spyOn(snapshotQueue, "destroy").mockImplementation(() => 0);

    const id = fresh.reserveRoom("1.2.3.4", "python");
    created.push(id);
    liveDoc(id, 0);

    await fresh.flushAndDestroyAll();
    // Without this ordering a queue parked behind an unref'd pacing timer is lost outright: the
    // listener is closed, nothing anchors the event loop, and Node exits.
    expect(order).toEqual(["release"]);
    expect(destroySpy).toHaveBeenCalled();
    expect(docs.has(id)).toBe(false);

    release.mockRestore();
    destroySpy.mockRestore();
    delete require.cache[path];
  });
});
