// The theme model, shared by the no-flash script, the provider and the toggle.
//
// Three stored values but only two rendered ones: "system" is resolved against
// `prefers-color-scheme` every time it is read, so it keeps tracking the OS
// instead of freezing whatever the OS happened to say when it was chosen.

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** Matches the `collabcode:` prefix `lib/user.ts` already uses for its keys. */
export const THEME_STORAGE_KEY = "collabcode:theme";

export const THEMES: Theme[] = ["light", "system", "dark"];

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

/** Reads the stored preference. Returns "system" for anything unset or corrupt. */
export function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    // Safari in private mode throws on localStorage access.
    return "system";
  }
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not being able to remember the choice is survivable; crashing is not.
  }
}

/** The single writer of the class the `dark:` variant keys on (see globals.css). */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * The no-flash script, as source text for a `<script>` in <head>.
 *
 * It has to run *before first paint*, which is why it is an inline script in the
 * document head rather than anything React does: `ThemeProvider` cannot help,
 * because by the time React hydrates the browser has already painted the body
 * once — light-mode chrome flashing at someone who chose dark. `next/script`
 * with `beforeInteractive` is also not enough; it guarantees ordering relative
 * to other scripts, not to first paint.
 *
 * Written as an IIFE and wrapped in try/catch so a storage exception can never
 * leave the page blank. <html> already carries `suppressHydrationWarning`, which
 * is what makes mutating its class list here safe.
 */
export const THEME_SCRIPT = `(function(){try{
var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
var d=s==="dark"||((s===null||s==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.toggle("dark",d);
}catch(e){}})();`;
