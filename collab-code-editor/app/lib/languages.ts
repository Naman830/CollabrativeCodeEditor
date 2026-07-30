// The one list of supported languages: dropdown label, Monaco id, and file
// extension. Free of browser and Next APIs so both the editor and the
// `/api/execute` route can import it instead of keeping two lists that drift.
//
// Piston's pinned versions stay in the route — they belong to the sandbox
// image, not to the language.
//
// Since §10.1 a language is a property of the *room*, chosen once at creation
// and told to the sync server, rather than a per-user editing preference. The
// server keeps its own copy of the `value` list (`ROOM_LANGUAGES` in
// `server/roomState.js`) because the two workspaces share no code — keep them in
// step by hand.

export const LANGUAGES = [
  { label: "JavaScript", value: "javascript", ext: "js" },
  { label: "Python", value: "python", ext: "py" },
  { label: "TypeScript", value: "typescript", ext: "ts" },
  { label: "Java", value: "java", ext: "java" },
  { label: "C++", value: "cpp", ext: "cpp" },
] as const;

export type LanguageValue = (typeof LANGUAGES)[number]["value"];

/** The one used when nothing else is known: an unset query param, an old room. */
export const DEFAULT_LANGUAGE: LanguageValue = "javascript";

/** Narrows an untrusted string — a query param, a `GET /rooms/:id` body. */
export function isLanguage(value: unknown): value is LanguageValue {
  return LANGUAGES.some((lang) => lang.value === value);
}

/** Dropdown label for a language id, falling back to the id itself. */
export function languageLabel(language: string): string {
  return LANGUAGES.find((lang) => lang.value === language)?.label ?? language;
}

/** File extension for a language id, without the leading dot. */
export function fileExtFor(language: string): string {
  return LANGUAGES.find((lang) => lang.value === language)?.ext ?? "txt";
}

/**
 * Filename the Save button hands to the browser for a single-file room, and the
 * name the room's first file is created under. `main.<ext>` matches what the
 * execute route sends Piston, so a download runs the same way locally. Java is
 * the exception: javac needs the file named after its public class.
 */
export function downloadFileName(language: string): string {
  if (language === "java") return "Main.java";
  return `main.${fileExtFor(language)}`;
}

/**
 * Extension -> Monaco language id, for files whose name does not match the room
 * language. A room is created in one language and every new file gets that
 * language's extension (§10.1), but a rename is free-form, so `notes.md` in a
 * Python room should not be highlighted as Python.
 *
 * Only ids Monaco ships a tokenizer for. Anything unrecognised falls through to
 * the room language, which is the right guess far more often than "plaintext".
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  java: "java",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
  c: "c",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  sql: "sql",
  txt: "plaintext",
};

/** The Monaco language id for one file in a room of `roomLanguage`. */
export function monacoLanguageForFile(filename: string, roomLanguage: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return roomLanguage;
  return EXTENSION_LANGUAGE[filename.slice(dot + 1).toLowerCase()] ?? roomLanguage;
}

/**
 * Name for a file the user has just added, with the room language's extension
 * already applied (§10.1's "auto-suggest correct extension"). `taken` is the set
 * of names already in the room, so the suggestion never collides — two files with
 * one name would produce one ambiguous tab and one ambiguous zip entry.
 *
 * Deliberately not `Main.java` for anything but the first file: javac only cares
 * about the file holding the public class, and every later file in a Java room is
 * a different class.
 */
export function newFileName(language: string, taken: Iterable<string>): string {
  const ext = fileExtFor(language);
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  const capitalized = language === "java";
  for (let n = 1; ; n += 1) {
    const stem = capitalized ? `File${n}` : `file${n}`;
    const candidate = `${stem}.${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * What a brand-new room's entry file is seeded with, once, after the provider
 * syncs (see `useCollabRoom`). Before §10.1 this was a single hardcoded
 * `console.log` regardless of the language selected, so every non-JavaScript room
 * opened on a program that could not run.
 */
export function starterCode(language: string): string {
  switch (language) {
    case "python":
      return 'print("Hello, world!")\n';
    case "typescript":
      return 'const greeting: string = "Hello, world!";\nconsole.log(greeting);\n';
    case "java":
      return [
        "public class Main {",
        "    public static void main(String[] args) {",
        '        System.out.println("Hello, world!");',
        "    }",
        "}",
        "",
      ].join("\n");
    case "cpp":
      return [
        "#include <iostream>",
        "",
        "int main() {",
        '    std::cout << "Hello, world!" << std::endl;',
        "    return 0;",
        "}",
        "",
      ].join("\n");
    default:
      return 'console.log("Hello, world!");\n';
  }
}
