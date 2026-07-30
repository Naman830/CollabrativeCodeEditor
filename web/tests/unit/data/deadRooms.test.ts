import { describe, expect, it, vi } from "vitest";

// The module is server-only and constructs a Prisma client at import; the pure exports under
// test never touch it.
vi.mock("@/lib/data/db", () => ({ prisma: {} }));

const {
  DEAD_ROOM_ID,
  isTruncated,
  readSnapshotFiles,
  relativeTime,
  lifetime,
  absoluteTime,
} = await import("@/lib/data/deadRooms");

describe("AUTH-04 DEAD_ROOM_ID gates every query", () => {
  it("AUTH-04a accepts a v4 uuid in either case", () => {
    expect(DEAD_ROOM_ID.test("0189c4f3-e7fc-42f3-94f7-1c8665ef56e7")).toBe(true);
    expect(DEAD_ROOM_ID.test("0189C4F3-E7FC-42F3-94F7-1C8665EF56E7")).toBe(true);
  });

  it("AUTH-04b rejects anything that would reach the driver and 500 on the uuid cast", () => {
    for (const bad of [
      "",
      "not-a-uuid",
      "0189c4f3-e7fc-42f3-94f7-1c8665ef56e",
      "0189c4f3-e7fc-42f3-94f7-1c8665ef56e77",
      "'; DROP TABLE dead_rooms; --",
      " 0189c4f3-e7fc-42f3-94f7-1c8665ef56e7 ",
      "0189c4f3-e7fc-42f3-94f7-1c8665ef56e7\n",
    ]) {
      expect(DEAD_ROOM_ID.test(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  // Anchoring: an unanchored regex would let a prefix or suffix through.
  it("AUTH-04c is anchored at both ends", () => {
    const id = "0189c4f3-e7fc-42f3-94f7-1c8665ef56e7";
    expect(DEAD_ROOM_ID.test(`x${id}`)).toBe(false);
    expect(DEAD_ROOM_ID.test(`${id}x`)).toBe(false);
  });
});

describe("VAL-05 readSnapshotFiles is the only reader of the files jsonb", () => {
  it("VAL-05a a non-array column still yields one renderable entry", () => {
    for (const raw of [null, undefined, {}, "x", 42, []]) {
      const files = readSnapshotFiles(raw);
      expect(files).toHaveLength(1);
      expect(files[0]).toEqual({ filename: "main.txt", content: "" });
    }
  });

  it("VAL-05b path separators are stripped before the name reaches <a download> or a zip key", () => {
    expect(readSnapshotFiles([{ filename: "../../etc/passwd", content: "x" }])[0].filename).toBe(
      "....etcpasswd"
    );
    expect(
      readSnapshotFiles([{ filename: "..\\..\\windows\\system32", content: "x" }])[0].filename
    ).toBe("....windowssystem32");
  });

  it("VAL-05c a name of only dots is not a filename", () => {
    for (const dots of [".", "..", "..."]) {
      expect(readSnapshotFiles([{ filename: dots, content: "" }])[0].filename).toBe("untitled.txt");
    }
  });

  // This is the bug the shared sanitizer fixed: the old local copy cut with a UTF-16 slice, so a
  // 33-code-point name of 65 units lost half a surrogate pair into a download name and a zip key.
  it("VAL-05d a surrogate pair straddling the 64-char cap is never halved", () => {
    const name = "a" + "\u{1F600}".repeat(32); // 33 code points, 65 UTF-16 units
    const out = readSnapshotFiles([{ filename: name, content: "x" }])[0].filename;
    expect([...out].length).toBeLessThanOrEqual(64);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });

  it("VAL-05e non-string fields degrade rather than throw", () => {
    expect(readSnapshotFiles([{ filename: 42, content: 42 }])[0]).toEqual({
      filename: "untitled.txt",
      content: "",
    });
    expect(readSnapshotFiles([null, 5, "x", { filename: "a.py", content: "b" }])).toHaveLength(1);
  });

  it("VAL-05f the reader's cap is at least the writer's, so no file can be hidden", () => {
    // The server writes at most 20 files; this reader keeps 50. Reader >= writer, always.
    const many = Array.from({ length: 60 }, (_, i) => ({ filename: `f${i}.py`, content: "" }));
    expect(readSnapshotFiles(many)).toHaveLength(50);
    const twentyOne = Array.from({ length: 21 }, (_, i) => ({ filename: `f${i}.py`, content: "" }));
    expect(readSnapshotFiles(twentyOne)).toHaveLength(21);
  });
});

describe("DRIFT-02 the truncation marker matches the writer's byte-for-byte", () => {
  const MARKER = "\n\n/* --- snapshot truncated: room exceeded 256 KB --- */\n";

  it("DRIFT-02a endsWith, never includes", () => {
    expect(isTruncated(`code${MARKER}`)).toBe(true);
    // A user who typed the sentence themselves mid-file is not a truncated snapshot.
    expect(isTruncated(`${MARKER}more code`)).toBe(false);
    expect(isTruncated("")).toBe(false);
  });
});

describe("UF-09 profile dates are pure deltas, so server and browser agree", () => {
  const at = (ms: number) => new Date(1_000_000_000_000 - ms);
  const now = 1_000_000_000_000;

  it("UF-09a relativeTime boundaries", () => {
    expect(relativeTime(at(0), now)).toBe("just now");
    expect(relativeTime(at(59_999), now)).toBe("just now");
    expect(relativeTime(at(60_000), now)).toBe("1 minute ago");
    expect(relativeTime(at(120_000), now)).toBe("2 minutes ago");
    expect(relativeTime(at(3_600_000), now)).toBe("1 hour ago");
    expect(relativeTime(at(86_400_000), now)).toBe("1 day ago");
  });

  it("UF-09b a future date clamps rather than reading '-3 minutes ago'", () => {
    expect(relativeTime(new Date(now + 60_000), now)).toBe("just now");
  });

  it("UF-09c lifetime, including the documented 59_999 -> '60 seconds' rounding", () => {
    const from = new Date(0);
    expect(lifetime(from, new Date(0))).toBe("0 seconds");
    expect(lifetime(from, new Date(500))).toBe("1 second");
    expect(lifetime(from, new Date(59_999))).toBe("60 seconds");
    expect(lifetime(from, new Date(60_000))).toBe("1 minute");
    expect(lifetime(from, new Date(3_600_000))).toBe("1 hour");
    expect(lifetime(from, new Date(3_660_000))).toBe("1 hour 1 minute");
    // Inverted dates cannot render a negative lifetime.
    expect(lifetime(new Date(60_000), new Date(0))).toBe("0 seconds");
  });

  it("UF-09d absoluteTime is UTC, so it is timezone-independent by construction", () => {
    expect(absoluteTime(new Date(Date.UTC(2026, 6, 30, 12, 34, 56)))).toBe(
      "2026-07-30 12:34:56 UTC"
    );
  });
});
