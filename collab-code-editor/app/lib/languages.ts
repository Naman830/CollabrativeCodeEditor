// The one list of supported languages: dropdown label, Monaco id, and file
// extension. Free of browser and Next APIs so both the editor and the
// `/api/execute` route can import it instead of keeping two lists that drift.
//
// Piston's pinned versions stay in the route — they belong to the sandbox
// image, not to the language.

export const LANGUAGES = [
  { label: "JavaScript", value: "javascript", ext: "js" },
  { label: "Python", value: "python", ext: "py" },
  { label: "TypeScript", value: "typescript", ext: "ts" },
  { label: "Java", value: "java", ext: "java" },
  { label: "C++", value: "cpp", ext: "cpp" },
] as const;

export type LanguageValue = (typeof LANGUAGES)[number]["value"];

/** Dropdown label for a language id, falling back to the id itself. */
export function languageLabel(language: string): string {
  return LANGUAGES.find((lang) => lang.value === language)?.label ?? language;
}

/** File extension for a language id, without the leading dot. */
export function fileExtFor(language: string): string {
  return LANGUAGES.find((lang) => lang.value === language)?.ext ?? "txt";
}

/**
 * Filename the Save button hands to the browser. `main.<ext>` matches what the
 * execute route sends Piston, so a download runs the same way locally. Java is
 * the exception: javac needs the file named after its public class.
 */
export function downloadFileName(language: string): string {
  if (language === "java") return "Main.java";
  return `main.${fileExtFor(language)}`;
}
