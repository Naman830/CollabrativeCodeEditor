import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Several files in this repo carry regex literals with \u0000 and \uD800-\uDFFF escapes, and
// tool-call arguments JSON-decode \uXXXX — so an editing tool can silently replace the six
// characters `\u0000` with one real NUL byte and turn the file binary. It happened while writing
// this suite. CLAUDE.md prescribed `grep -P '\x00'` as the guard, which does NOT work: grep
// classifies the file as binary and reports nothing without `-a`. This is that guard, done
// properly, at the byte level.

const WEB = join(import.meta.dirname, "../../..");
const REPO = join(WEB, "..");

// INVARIANT: this must cover the repo's prose too, not just web/src. The guard originally scanned
// only web/, and the very next thing to be corrupted was CLAUDE.md — writing the NUL escape into a
// *paragraph explaining the NUL escape* produced three real NUL bytes and turned the file binary.
// A guard that does not cover the file that documents it is not a guard.
const ROOTS = [
  join(WEB, "src"),
  join(WEB, "tests"),
  join(WEB, "e2e"),
  join(WEB, "prisma"),
  join(REPO, "server/src"),
  join(REPO, "server/tests"),
  join(REPO, "docs"),
];

// The root-level prose, which is where the rationale for all of this lives.
const ROOT_FILES = ["CLAUDE.md", "README.md", "docker-compose.yml"].map((f) => join(REPO, f));

const EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".css", ".json", ".prisma", ".md", ".yml"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "generated") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = [
  ...ROOTS.flatMap((dir) => {
    try {
      return walk(dir);
    } catch {
      return [];
    }
  }),
  ...ROOT_FILES.filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  }),
];

describe("GUARD-01 no source file carries an unstorable byte", () => {
  it("GUARD-01a the walk actually found the source tree", () => {
    expect(files.length).toBeGreaterThan(80);
  });

  it("GUARD-01b no NUL or stray control byte", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file);
      for (const [index, byte] of raw.entries()) {
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
          offenders.push(`${relative(REPO, file)} byte ${index} = 0x${byte.toString(16)}`);
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
        offenders.push(relative(REPO, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("GUARD-01d the files that legitimately hold these escapes hold them as text", () => {
    // If an editing tool ever decodes them for real, the assertions above fail — but this one
    // says *why* those files are the ones to watch, and fails if the escapes go missing entirely
    // (which would mean the sanitizer silently stopped stripping anything).
    for (const [path, needle] of [
      ["web/src/lib/collab/roomFiles.ts", "\\u0000"],
      ["web/src/lib/collab/user.ts", "\\u0000"],
      ["server/src/rooms/state.js", "\\u0000"],
      ["CLAUDE.md", "\\u0000"],
    ] as const) {
      const text = readFileSync(join(REPO, path), "utf8");
      expect(text, `${path} should still declare the escape as text`).toContain(needle);
    }
  });
});
