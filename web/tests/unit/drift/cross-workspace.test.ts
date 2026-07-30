// The hand-maintained cross-workspace duplications, made executable. CLAUDE.md lists eight and
// says plainly that "nothing in the build compares the two" for several of them — this file is
// that comparison. It runs in its own forked process because it re-requires server modules under
// different env to prove a divergence, and those modules read process.env at load.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

import { LANGUAGES, DEFAULT_LANGUAGE, downloadFileName } from "@/lib/editor/languages";
import { MEMBER_MIN_CONNECTED_MS } from "@/lib/data/persistence";
import { sanitizeFileName, FILES_MAP_NAME, fileTextName, MAX_FILES } from "@/lib/collab/roomFiles";
import { sanitizeName } from "@/lib/collab/user";
import { readPeers } from "@/lib/collab/awareness";
import { isTruncated, readSnapshotFiles } from "@/lib/data/deadRooms";
import { STALE_RUN_MS } from "@/lib/sandbox/executionState";
import { createRateLimiter as webLimiter, clientKey as webClientKey } from "@/lib/sandbox/rateLimit";

const require = createRequire(import.meta.url);
const REPO = join(import.meta.dirname, "../../../..");
const SERVER = join(REPO, "server/src");

delete process.env.DATABASE_URL;
delete process.env.MEMBER_MIN_CONNECTED_MS;

const serverState = require(join(SERVER, "rooms/state.js"));
const serverRateLimit = require(join(SERVER, "http/rateLimit.js"));
const serverConnection = require(join(SERVER, "sync/connection.js"));

function read(relative: string): string {
  return readFileSync(join(REPO, relative), "utf8");
}

/** A room whose single member qualifies, so buildSnapshot actually produces output. */
function snapshotOf(files: { id: string; name: string; text: string }[], language = "python") {
  const roomId = `drift-${Math.random().toString(36).slice(2)}`;
  serverState.createRoomState(roomId, "1.2.3.4", language);
  const doc = new Y.Doc() as Y.Doc & { awareness: Awareness };
  doc.awareness = new Awareness(doc);
  for (const [i, f] of files.entries()) {
    doc.getMap(FILES_MAP_NAME).set(f.id, { name: f.name, createdAt: i });
    doc.getText(fileTextName(f.id)).insert(0, f.text);
  }
  const conn = {};
  serverState.beginMemberSession(roomId, "user_1", Date.now() - (serverState.MEMBER_MIN_CONNECTED_MS + 5_000), conn);
  serverState.bindRoomObservers(roomId, doc);
  doc.transact(() => doc.getText(fileTextName(files[0].id)).insert(0, "x"), conn);
  const snap = serverState.buildSnapshot(roomId, doc, Date.now());
  serverState.deleteRoomState(roomId);
  return snap;
}

describe("DRIFT-10 the language allowlist exists twice", () => {
  it("DRIFT-10a ROOM_LANGUAGES equals LANGUAGES, in order", () => {
    expect(serverState.ROOM_LANGUAGES).toEqual(LANGUAGES.map((l) => l.value));
  });

  it("DRIFT-10b both default to javascript", () => {
    expect(serverState.DEFAULT_LANGUAGE).toBe(DEFAULT_LANGUAGE);
    expect(serverState.DEFAULT_LANGUAGE).toBe("javascript");
  });

  it("DRIFT-10c the server's legacy fallback filename matches the client's download name", () => {
    for (const { value } of LANGUAGES) {
      const snap = snapshotOf([{ id: "main", name: downloadFileName(value), text: "x" }], value);
      expect(snap.files[0].filename).toBe(downloadFileName(value));
    }
  });
});

describe("DRIFT-11 MEMBER_MIN_CONNECTED_MS is duplicated and env-overridable on one side only", () => {
  it("DRIFT-11a both copies are 60s by default", () => {
    expect(serverState.MEMBER_MIN_CONNECTED_MS).toBe(60_000);
    expect(MEMBER_MIN_CONNECTED_MS).toBe(60_000);
    expect(serverState.MEMBER_MIN_CONNECTED_MS).toBe(MEMBER_MIN_CONNECTED_MS);
  });

  it("DRIFT-11b overriding the server value silently desynchronises the in-room estimate", () => {
    // Executable form of the hazard: the frontend hardcodes the default and cannot see this var,
    // so the chip's countdown stops describing the rule it estimates. Nothing detects it at
    // runtime — which is exactly why it is asserted here.
    process.env.MEMBER_MIN_CONNECTED_MS = "3000";
    const path = require.resolve(join(SERVER, "rooms/state.js"));
    delete require.cache[path];
    const reloaded = require(path);
    expect(reloaded.MEMBER_MIN_CONNECTED_MS).toBe(3_000);
    expect(MEMBER_MIN_CONNECTED_MS).toBe(60_000); // unchanged, and unaware

    delete process.env.MEMBER_MIN_CONNECTED_MS;
    delete require.cache[path];
  });
});

describe("DRIFT-12 the truncation marker, compared behaviourally", () => {
  it("DRIFT-12a the writer's marker is what the reader's endsWith matches", () => {
    const snap = snapshotOf([{ id: "main", name: "main.py", text: "a".repeat(300 * 1024) }]);
    const content = snap.files[0].content;
    // Neither side exports the string; this proves they agree byte for byte.
    expect(isTruncated(content)).toBe(true);
    expect((content.match(/snapshot truncated/g) ?? []).length).toBe(1);
  });

  it("DRIFT-12b an untruncated snapshot is not falsely flagged", () => {
    const snap = snapshotOf([{ id: "main", name: "main.py", text: "small" }]);
    expect(isTruncated(snap.files[0].content)).toBe(false);
  });
});

describe("DRIFT-13 the two filename sanitizers agree", () => {
  const cases = [
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "main.py ",
    "n".repeat(200),
    `a${String.fromCodePoint(0x1f600).repeat(32)}`,
    `main${String.fromCharCode(0)}.py`,
    `main${String.fromCharCode(0xd800)}.py`,
    "ok name.py",
  ];

  it("DRIFT-13a identical output for every non-fallback case", () => {
    for (const raw of cases) {
      const client = sanitizeFileName(raw, "python");
      const server = snapshotOf([{ id: "main", name: raw, text: "x" }]).files[0].filename;
      expect(server, `for ${JSON.stringify(raw)}`).toBe(client);
    }
  });

  it("DRIFT-13b the ONE documented divergence is the dots-only fallback extension", () => {
    // The client knows the room language and returns untitled.py; the server's fallback is
    // untitled.txt for everything except java. Enumerated so it is a decision, not a surprise.
    for (const dots of [".", "..", "..."]) {
      expect(sanitizeFileName(dots, "python")).toBe("untitled.py");
      expect(snapshotOf([{ id: "main", name: dots, text: "x" }], "python").files[0].filename).toBe(
        "untitled.txt"
      );
    }
    // java is the exception on both sides.
    expect(sanitizeFileName(".", "java")).toBe("untitled.java");
    expect(snapshotOf([{ id: "main", name: ".", text: "x" }], "java").files[0].filename).toBe(
      "untitled.java"
    );
  });
});

describe("DRIFT-14 sanitizeName and the colour fallback exist twice", () => {
  it("DRIFT-14a the server's participant name matches the client's sanitizeName", () => {
    const roomId = "drift-names";
    serverState.createRoomState(roomId, "1.2.3.4", "python");
    const doc = new Y.Doc() as Y.Doc & { awareness: Awareness };
    doc.awareness = new Awareness(doc);
    serverState.bindRoomObservers(roomId, doc);

    const raw = `${String.fromCharCode(0)}${"n".repeat(40)}`;
    doc.awareness.setLocalStateField("user", { name: raw, color: "#ef9a9a" });

    const participants = [...serverState.getRoomState(roomId).participants.values()];
    expect(participants[0].name).toBe(sanitizeName(raw));
    serverState.deleteRoomState(roomId);
  });

  it("DRIFT-14b both sides resolve an unusable colour to the same grey", () => {
    const roomId = "drift-colors";
    serverState.createRoomState(roomId, "1.2.3.4", "python");
    const doc = new Y.Doc() as Y.Doc & { awareness: Awareness };
    doc.awareness = new Awareness(doc);
    serverState.bindRoomObservers(roomId, doc);
    doc.awareness.setLocalStateField("user", { name: "X", color: "red } body {}" });

    const serverColor = [...serverState.getRoomState(roomId).participants.values()][0].color;
    const clientColor = readPeers(
      { getStates: () => new Map([[1, { user: { name: "X", color: "red } body {}" } }]]) } as never,
      1
    )[0].color;
    expect(serverColor).toBe(clientColor);
    serverState.deleteRoomState(roomId);
  });
});

describe("DRIFT-15 the two rate limiters behave identically", () => {
  it("DRIFT-15a the same key/time sequence yields the same verdict stream", () => {
    // The only mechanism that catches a one-sided edit, and it needs no new exports.
    const web = webLimiter({ limit: 2, windowMs: 60_000, maxKeys: 3 });
    const server = serverRateLimit.createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 3 });
    const keys = ["a", "b", "c", "a", "d", "e", "a", "b", "b", "c"];
    const webStream = keys.map((k) => web(k).allowed);
    const serverStream = keys.map((k) => server(k).allowed);
    expect(serverStream).toEqual(webStream);
  });

  it("DRIFT-15b clientKey shares its trust rule despite different request shapes", () => {
    const chain = "1.1.1.1, 198.51.100.7";
    const fromWeb = webClientKey(
      new Request("http://localhost/x", { headers: { "x-forwarded-for": chain } })
    );
    const fromServer = serverRateLimit.clientKey({
      headers: { "x-forwarded-for": chain },
      socket: { remoteAddress: "10.0.0.1" },
    });
    // Right-most trusted hop on both sides.
    expect(fromWeb).toBe("198.51.100.7");
    expect(fromServer).toBe(fromWeb);
  });
});

describe("DRIFT-16 the WebSocket close codes are contract-coupled to the client", () => {
  it("DRIFT-16a 4404 means room-not-found on both sides", () => {
    expect(serverConnection.CLOSE_ROOM_NOT_FOUND).toBe(4404);
    const hook = read("web/src/hooks/useCollabRoom.ts");
    const declared = hook.match(/const CLOSE_ROOM_NOT_FOUND = (\d+);/)?.[1];
    expect(Number(declared)).toBe(serverConnection.CLOSE_ROOM_NOT_FOUND);
  });

  it("DRIFT-16b a restart uses 1012, never 4404 — the client treats 4404 as permanent", () => {
    expect(serverConnection.CLOSE_SERVICE_RESTART).toBe(1012);
    expect(serverConnection.CLOSE_SERVICE_RESTART).not.toBe(serverConnection.CLOSE_ROOM_NOT_FOUND);
  });
});

describe("DRIFT-17 docker-compose's Piston ceilings vs the route's per-request limits", () => {
  // CLAUDE.md: "Piston 400s a request that exceeds its configured limit, so the two files are one
  // setting in two places." Nothing checked it until now.
  const compose = read("docker-compose.yml");
  const route = read("web/src/app/api/execute/route.ts");

  const composeValue = (key: string) =>
    Number(compose.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1] ?? Number.NaN);
  const routeValue = (name: string) => {
    const raw = route.match(new RegExp(`const ${name} = ([^;]+);`))?.[1] ?? "";
    return Number(new Function(`return (${raw})`)());
  };

  const pairs: [string, string][] = [
    ["PISTON_RUN_TIMEOUT", "RUN_TIMEOUT_MS"],
    ["PISTON_RUN_CPU_TIME", "RUN_CPU_TIME_MS"],
    ["PISTON_COMPILE_TIMEOUT", "COMPILE_TIMEOUT_MS"],
    ["PISTON_COMPILE_CPU_TIME", "COMPILE_CPU_TIME_MS"],
    ["PISTON_RUN_MEMORY_LIMIT", "RUN_MEMORY_LIMIT_BYTES"],
    ["PISTON_COMPILE_MEMORY_LIMIT", "COMPILE_MEMORY_LIMIT_BYTES"],
  ];

  it.each(pairs)("DRIFT-17a %s must be >= the route's %s", (composeKey, routeKey) => {
    const ceiling = composeValue(composeKey);
    const requested = routeValue(routeKey);
    expect(Number.isFinite(ceiling), `${composeKey} missing from docker-compose.yml`).toBe(true);
    expect(Number.isFinite(requested), `${routeKey} missing from route.ts`).toBe(true);
    expect(requested).toBeLessThanOrEqual(ceiling);
  });

  it("DRIFT-17b the output cap is raised well above Piston's 1 KB default", () => {
    // At the default, Piston SIGABRTs the sandbox instead of truncating, which reads to the user
    // as a crash in their own code.
    expect(composeValue("PISTON_OUTPUT_MAX_SIZE")).toBeGreaterThan(1024);
  });

  it("DRIFT-17c Piston stays bound to loopback", () => {
    // The tunnel that exposed this privileged container publicly was removed on purpose.
    expect(compose).toMatch(/127\.0\.0\.1:2000:2000/);
    expect(compose).not.toMatch(/^\s*-\s*"?2000:2000/m);
  });
});

describe("DRIFT-18 the hand-written INSERT vs schema.prisma", () => {
  // CLAUDE.md: "a column renamed in schema.prisma must be renamed in those statements by hand —
  // nothing checks it." This is the check.
  const dbSource = read("server/src/storage/db.js");
  const schema = read("web/prisma/schema.prisma");

  function insertColumns(table: string): string[] {
    const match = dbSource.match(new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)`));
    return (match?.[1] ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .sort();
  }

  function schemaColumns(model: string): string[] {
    const body = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    const columns: string[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;
      const mapped = trimmed.match(/@map\("([^"]+)"\)/);
      const field = trimmed.split(/\s+/)[0];
      const type = trimmed.split(/\s+/)[1] ?? "";
      // Skip relation fields: they are not columns.
      if (/^(DeadRoom|DeadRoomMember)/.test(type)) continue;
      columns.push(mapped ? mapped[1] : field);
    }
    return columns.sort();
  }

  it("DRIFT-18a dead_rooms columns match", () => {
    expect(insertColumns("dead_rooms")).toEqual(schemaColumns("DeadRoom"));
  });

  it("DRIFT-18b dead_room_members columns match", () => {
    expect(insertColumns("dead_room_members")).toEqual(schemaColumns("DeadRoomMember"));
  });

  it("DRIFT-18c the id is supplied by the statement, since the server has no Prisma client", () => {
    // @default(uuid()) is client-side only; the generated migration has no DEFAULT clause, so
    // dropping gen_random_uuid() here fails every write on a null id.
    expect(dbSource).toContain("gen_random_uuid()");
  });

  it("DRIFT-18d write-once rests on room_id being UNIQUE", () => {
    expect(dbSource).toMatch(/ON CONFLICT \(room_id\) DO NOTHING/);
    expect(schema).toMatch(/roomId\s+String\s+@unique/);
  });

  it("DRIFT-18e the creator's IP is not among the columns", () => {
    expect(insertColumns("dead_rooms")).not.toContain("creator_key");
    expect(dbSource).not.toMatch(/creator_key/);
  });
});

describe("DRIFT-19 the three nested timeouts stay ordered", () => {
  it("DRIFT-19a sandbox limits < the route's fetch abort < the client watchdog", () => {
    const route = read("web/src/app/api/execute/route.ts");
    const value = (name: string) =>
      Number(new Function(`return (${route.match(new RegExp(`const ${name} = ([^;]+);`))?.[1]})`)());

    const sandbox = value("COMPILE_TIMEOUT_MS") + value("RUN_TIMEOUT_MS");
    const fetchAbort = value("PISTON_TIMEOUT_MS");
    expect(sandbox).toBeLessThan(fetchAbort);
    expect(fetchAbort).toBeLessThan(STALE_RUN_MS);
  });

  it("DRIFT-19b the DB connect timeout stays under the shutdown flush deadline", () => {
    const db = read("server/src/storage/db.js");
    const lifecycle = read("server/src/rooms/lifecycle.js");
    expect(db).toMatch(/DB_CONNECT_TIMEOUT_MS, 10_000/);
    expect(lifecycle).toMatch(/SNAPSHOT_FLUSH_MS, 20_000/);
  });
});

describe("DRIFT-20 the reader's file cap is never below the writer's", () => {
  it("DRIFT-20a a reader cap below the writer's would hide a stored file", () => {
    const twentyOne = Array.from({ length: 21 }, (_, i) => ({
      filename: `f${i}.py`,
      content: "",
    }));
    // The server writes at most MAX_FILES (20); the reader must keep at least that many.
    expect(readSnapshotFiles(twentyOne)).toHaveLength(21);
    expect(MAX_FILES).toBe(20);
  });
});
