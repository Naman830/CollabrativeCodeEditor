// The single enumeration of the languages the editor supports: dropdown
// labels, Monaco's language id, and the file extension. Deliberately free of
// browser and Next APIs so both the client editor and the `/api/execute`
// route handler can import it — the extension used to live only in the
// route's LANGUAGE_MAP, which the client can't touch (it imports
// `next/server`), and duplicating it is exactly how the two lists drift.
//
// Piston's pinned versions stay in `app/api/execute/route.ts`: they're a
// property of the sandbox image, not of the language.

export const LANGUAGES = [
  { label: "JavaScript", value: "javascript", ext: "js" },
  { label: "Python", value: "python", ext: "py" },
  { label: "TypeScript", value: "typescript", ext: "ts" },
  { label: "Java", value: "java", ext: "java" },
  { label: "C++", value: "cpp", ext: "cpp" },
] as const;

export type LanguageValue = (typeof LANGUAGES)[number]["value"];

/** File extension for a language id, without the leading dot. */
export function fileExtFor(language: string): string {
  return LANGUAGES.find((lang) => lang.value === language)?.ext ?? "txt";
}

/**
 * Name for the file the Save button hands to the browser.
 *
 * `main.<ext>` matches the name the execute route already gives Piston, so a
 * downloaded file runs the same way locally. Java is the one capitalized
 * case: javac requires the file to be named after its public class, so
 * `Main.java` is what compiles — `main.java` would not.
 */
export function downloadFileName(language: string): string {
  if (language === "java") return "Main.java";
  return `main.${fileExtFor(language)}`;
}
