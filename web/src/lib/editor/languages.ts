// Keep the `value` list in sync with `ROOM_LANGUAGES` in `server/src/rooms/state.js`.

export const LANGUAGES = [
  { label: "JavaScript", value: "javascript", ext: "js" },
  { label: "Python", value: "python", ext: "py" },
  { label: "TypeScript", value: "typescript", ext: "ts" },
  { label: "Java", value: "java", ext: "java" },
  { label: "C++", value: "cpp", ext: "cpp" },
] as const;

export type LanguageValue = (typeof LANGUAGES)[number]["value"];

export const DEFAULT_LANGUAGE: LanguageValue = "javascript";

export function isLanguage(value: unknown): value is LanguageValue {
  return LANGUAGES.some((lang) => lang.value === value);
}

export function languageLabel(language: string): string {
  return LANGUAGES.find((lang) => lang.value === language)?.label ?? language;
}

export function fileExtFor(language: string): string {
  return LANGUAGES.find((lang) => lang.value === language)?.ext ?? "txt";
}

// `main.<ext>` matches what the execute route sends Piston; javac needs the public class's name.
export function downloadFileName(language: string): string {
  if (language === "java") return "Main.java";
  return `main.${fileExtFor(language)}`;
}

// Only ids Monaco ships a tokenizer for; anything unrecognised falls back to the room language.
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

export function monacoLanguageForFile(filename: string, roomLanguage: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return roomLanguage;
  return EXTENSION_LANGUAGE[filename.slice(dot + 1).toLowerCase()] ?? roomLanguage;
}

// Must not collide with `taken`: duplicate names give one ambiguous tab and zip entry.
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
