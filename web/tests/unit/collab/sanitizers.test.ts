import { describe, expect, it } from "vitest";
import { sanitizeName, displayName, initials, CURSOR_COLORS, randomColor } from "@/lib/collab/user";
import {
  sanitizeFileName,
  readRoomFiles,
  resolveEntryFile,
  fileTextName,
  modelPathFor,
  ENTRY_FILE_ID,
  MAX_FILES,
  MAX_FILENAME_LENGTH,
} from "@/lib/collab/roomFiles";
import { HOSTILE_FILENAMES, GRINNING, LONE_HIGH, LONE_LOW, NUL, RTL_OVERRIDE, ZWSP } from "../../fixtures/hostile";

const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s) || /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("VAL-01 sanitizeName", () => {
  it("VAL-01a strips NUL before collapsing control characters, not after", () => {
    // Ordering matters: if the control-char pass ran first, NUL would become a space and the
    // result would be "Nam an". This assertion is the ordering guard.
    expect(sanitizeName(`${NUL}Nam${NUL}an`)).toBe("Naman");
  });

  it("VAL-01b removes unpaired surrogates and keeps real pairs", () => {
    expect(sanitizeName(`A${LONE_HIGH}B`)).toBe("AB");
    expect(sanitizeName(`A${LONE_LOW}B`)).toBe("AB");
    expect(sanitizeName(`A${GRINNING}B`)).toBe(`A${GRINNING}B`);
  });

  it("VAL-01c cuts to 24 CODE POINTS, so a pair at the boundary is never halved", () => {
    const out = sanitizeName(`${"a".repeat(23)}${GRINNING}b`);
    expect([...out].length).toBe(24);
    expect(out.length).toBe(25); // 25 UTF-16 units: the pair survived whole
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("VAL-01d collapses control characters and whitespace runs", () => {
    expect(sanitizeName(`A${String.fromCharCode(1)}${String.fromCharCode(31)}${String.fromCharCode(127)}B`)).toBe("A B");
    expect(sanitizeName("  a   b  ")).toBe("a b");
    expect(sanitizeName("  \t\n  ")).toBe("");
  });

  it("VAL-01e caps a long name at 24 code points", () => {
    expect(sanitizeName("a".repeat(200))).toHaveLength(24);
  });

  // Recorded as current behaviour and a known gap, not as a claim of safety.
  it("VAL-01f RTL overrides and zero-width spaces survive (documented gap)", () => {
    expect(sanitizeName(`A${RTL_OVERRIDE}B`)).toContain(RTL_OVERRIDE);
    expect(sanitizeName(`A${ZWSP}B`)).toContain(ZWSP);
  });

  it("VAL-01g exotic whitespace IS matched by \\s and collapses", () => {
    const nbsp = String.fromCharCode(0x00a0);
    expect(sanitizeName(`A${nbsp}B`)).toBe("A B");
    expect(sanitizeName(`A${String.fromCharCode(0x2028)}B`)).toBe("A B");
  });
});

describe("VAL-02 displayName and initials", () => {
  const user = (firstName: string, lastName: string) => ({ firstName, lastName, color: CURSOR_COLORS[0] });

  it("VAL-02a abbreviates the surname", () => {
    expect(displayName(user("Naman", "Singla"))).toBe("Naman S.");
  });

  it("VAL-02b a missing surname degrades rather than showing a stray dot", () => {
    expect(displayName(user("Naman", ""))).toBe("Naman");
  });

  it("VAL-02c initials, including the empty case", () => {
    expect(initials({ firstName: "Ada", lastName: "Lovelace" })).toBe("AL");
    expect(initials({ firstName: "", lastName: "" })).toBe("");
  });
});

describe("VAL-03 the cursor palette is closed", () => {
  it("VAL-03a eight entries, every one a plain lowercase-safe hex", () => {
    expect(CURSOR_COLORS).toHaveLength(8);
    for (const color of CURSOR_COLORS) expect(/^#[0-9a-f]{6}$/i.test(color)).toBe(true);
  });

  it("VAL-03b randomColor only ever returns a palette entry", () => {
    for (let i = 0; i < 200; i++) expect(CURSOR_COLORS).toContain(randomColor());
  });
});

describe("VAL-04 sanitizeFileName", () => {
  it("VAL-04a path separators go, because the name reaches <a download> and a zip key", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeFileName("..\\..\\windows\\system32")).toBe("....windowssystem32");
    for (const { input } of HOSTILE_FILENAMES) {
      const out = sanitizeFileName(input);
      expect(out).not.toContain("/");
      expect(out).not.toContain("\\");
    }
  });

  it("VAL-04b a name of only dots is not a filename", () => {
    for (const dots of [".", "..", "...", ".".repeat(70)]) {
      expect(sanitizeFileName(dots, "python")).toBe("untitled.py");
      expect(sanitizeFileName(dots)).toBe("untitled.txt");
    }
    // Java is the one capitalized extension elsewhere, but the fallback stem is lowercase.
    expect(sanitizeFileName(".", "java")).toBe("untitled.java");
  });

  it("VAL-04c cuts to 64 code points without halving a pair", () => {
    const out = sanitizeFileName(`a${GRINNING.repeat(32)}`);
    expect([...out].length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(sanitizeFileName("n".repeat(200))).toHaveLength(64);
  });

  it("VAL-04d strips NUL and unpaired surrogates", () => {
    expect(sanitizeFileName(`main${NUL}.py`)).toBe("main.py");
    expect(sanitizeFileName(`main${LONE_HIGH}.py`)).toBe("main.py");
    expect(hasLoneSurrogate(sanitizeFileName(`main${LONE_HIGH}.py`))).toBe(false);
  });

  it("VAL-04e reproduces the end-to-end case CLAUDE.md records", () => {
    // CLAUDE.md writes the result as "....etcpasswd.py". That is very slightly wrong: the
    // internal space is *collapsed*, not removed, so the real value keeps it. Separators and the
    // lone surrogate are gone either way, which is the part that matters.
    expect(sanitizeFileName(`../../etc/pa sswd${LONE_HIGH}.py`)).toBe("....etcpa sswd.py");
    expect(hasLoneSurrogate(sanitizeFileName(`../../etc/pa sswd${LONE_HIGH}.py`))).toBe(false);
  });

  it("VAL-04f non-strings and empties reach the fallback", () => {
    for (const bad of [42, null, undefined, {}, ""]) {
      expect(sanitizeFileName(bad, "python")).toBe("untitled.py");
    }
  });
});

describe("VAL-06 readRoomFiles is the boundary on the peer-written files map", () => {
  const meta = (name: string, createdAt = 1) => ({ name, createdAt });

  it("VAL-06a rejects ids that could not be a Monaco model URI", () => {
    const entries: [string, unknown][] = [
      ["main", meta("a.py")],
      ["", meta("b.py")],
      ["a/b", meta("c.py")],
      ["a b", meta("d.py")],
      ["../x", meta("e.py")],
      ["a:b", meta("f.py")],
      ["x".repeat(65), meta("g.py")],
      ["ok-id_1.x", meta("h.py")],
    ];
    const ids = readRoomFiles(entries, "python").map((f) => f.id);
    expect(ids).toEqual(["main", "ok-id_1.x"]);
  });

  it("VAL-06b skips non-object metadata instead of throwing", () => {
    const files = readRoomFiles(
      [["main", meta("a.py")], ["b", null], ["c", 42], ["d", "x"]] as [string, unknown][],
      "python"
    );
    expect(files.map((f) => f.id)).toEqual(["main"]);
  });

  it("VAL-06c a non-finite createdAt sorts as 0 rather than poisoning the order", () => {
    const files = readRoomFiles(
      [
        ["z", { name: "z.py", createdAt: Number.NaN }],
        ["a", { name: "a.py", createdAt: 5 }],
      ] as [string, unknown][],
      "python"
    );
    // z's createdAt became 0, so it sorts first.
    expect(files.map((f) => f.id)).toEqual(["z", "a"]);
  });

  it("VAL-06d ordering is deterministic regardless of map iteration order", () => {
    const entries: [string, unknown][] = [
      ["c", meta("c.py", 2)],
      ["a", meta("a.py", 1)],
      ["b", meta("b.py", 1)],
    ];
    const forward = readRoomFiles(entries, "python").map((f) => f.id);
    const reverse = readRoomFiles([...entries].reverse(), "python").map((f) => f.id);
    // createdAt ascending, id as the tiebreak — the same on every viewer.
    expect(forward).toEqual(["a", "b", "c"]);
    expect(reverse).toEqual(forward);
  });

  it("VAL-06e duplicate names are numbered, case-insensitively", () => {
    const files = readRoomFiles(
      [
        ["a", meta("main.py", 1)],
        ["b", meta("main.py", 2)],
        ["c", meta("MAIN.PY", 3)],
      ] as [string, unknown][],
      "python"
    );
    // The counter goes before the extension and the original casing is preserved, so the third
    // file reads MAIN (3).PY — collision detection is case-insensitive, the rename is not.
    expect(files.map((f) => f.name)).toEqual(["main.py", "main (2).py", "MAIN (3).PY"]);
  });

  it("VAL-06f caps at MAX_FILES, keeping the earliest", () => {
    const entries = Array.from({ length: 25 }, (_, i) => [`id${i}`, meta(`f${i}.py`, i)] as [string, unknown]);
    const files = readRoomFiles(entries, "python");
    expect(files).toHaveLength(MAX_FILES);
    expect(files[0].id).toBe("id0");
  });

  it("VAL-06g a hostile filename is sanitized before it can be rendered or downloaded", () => {
    const files = readRoomFiles([["main", meta("../../etc/passwd")]], "python");
    expect(files[0].name).toBe("....etcpasswd");
  });
});

describe("VAL-07 resolveEntryFile survives a deleted entry", () => {
  const files = [
    { id: "main", name: "main.py", createdAt: 1 },
    { id: "b", name: "b.py", createdAt: 2 },
  ];

  it("VAL-07a resolves a real pointer", () => {
    expect(resolveEntryFile(files, "b")?.id).toBe("b");
  });

  it("VAL-07b falls back to the first file when the pointer names a deleted one", () => {
    for (const bad of ["gone", undefined, null, 42, ""]) {
      expect(resolveEntryFile(files, bad)?.id).toBe("main");
    }
  });

  it("VAL-07c an empty room has no entry file", () => {
    expect(resolveEntryFile([], "main")).toBeNull();
  });
});

describe("DRIFT-03 shared-document identifiers", () => {
  it("DRIFT-03a the entry id is the fixed string 'main'", () => {
    // A random id here would let two simultaneous seeders create two identical tabs.
    expect(ENTRY_FILE_ID).toBe("main");
  });

  it("DRIFT-03b the Y.Text name and model URI shapes are stable", () => {
    expect(fileTextName("main")).toBe("file:main");
    expect(modelPathFor("room-1", "main")).toBe("inmemory://room/room-1/main");
  });

  it("DRIFT-03c the caps the server mirrors", () => {
    expect(MAX_FILES).toBe(20);
    expect(MAX_FILENAME_LENGTH).toBe(64);
  });
});
