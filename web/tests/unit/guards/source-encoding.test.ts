import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Several files in this repo carry regex literals with \u0000 and \uD800-\uDFFF escapes, and
// tool-call arguments JSON-decode \uXXXX — so an editing tool can silently replace the six
// characters `\u0000` with one real NUL byte and turn the file binary. It happened while writing
// this suite. CLAUDE.md prescribed `grep -P '\x00'` as the guard, which does NOT work: grep
// classifies the file as binary and reports nothing without `-a`. This is that guard, done
// properly, at the byte level.

const ROOT = join(import.meta.dirname, "../../..");

const ROOTS = ["src", "tests", "prisma"];
const EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".css", ".json", ".prisma", ".md"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "generated") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => {
  try {
    return walk(join(ROOT, r));
  } catch {
    return [];
  }
});

describe("GUARD-01 no source file carries an unstorable byte", () => {
  it("GUARD-01a the walk actually found the source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("GUARD-01b no NUL or stray control byte", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file);
      for (const [index, byte] of raw.entries()) {
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
          offenders.push(`${relative(ROOT, file)} byte ${index} = 0x${byte.toString(16)}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("GUARD-01c every file is valid UTF-8, so no lone surrogate was written", () => {
    // A lone surrogate reaches disk as WTF-8 (ED A0 80), which strict UTF-8 rejects. Postgres
    // rejects the whole INSERT on one, so this is the same class of fault as a NUL.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const offenders: string[] = [];
    for (const file of files) {
      try {
        decoder.decode(readFileSync(file));
      } catch {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("GUARD-01d the files that legitimately hold these escapes hold them as text", () => {
    // If an editing tool ever decodes them for real, the assertions above fail — but this one
    // says *why* those files are the ones to watch, and fails if the escapes go missing entirely
    // (which would mean the sanitizer silently stopped stripping anything).
    for (const [path, needle] of [
      ["src/lib/collab/roomFiles.ts", "\\u0000"],
      ["src/lib/collab/user.ts", "\\u0000"],
    ] as const) {
      const text = readFileSync(join(ROOT, path), "utf8");
      expect(text, `${path} should still declare the escape as text`).toContain(needle);
    }
  });
});
