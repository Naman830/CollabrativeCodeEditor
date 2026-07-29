"use client";

// Theme state as an *external store*, not useState + useEffect.
//
// Two reasons, both already load-bearing elsewhere in this codebase (see
// `lib/user.ts`, which reads identity the same way):
//
//   1. The server snapshot has to differ from the client one — the server cannot
//      know what is in localStorage — and `useSyncExternalStore` is the sanctioned
//      way to say so. React renders the server snapshot during hydration and
//      swaps afterwards without a mismatch warning.
//   2. React 19's `react-hooks/set-state-in-effect` rule rejects the obvious
//      `useEffect(() => setTheme(readStoredTheme()))` version outright.
//
// The store is module scope, so every consumer shares one subscription and one
// `matchMedia` listener no matter how many components call `useTheme()`.

import { createContext, useContext, useSyncExternalStore } from "react";
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type ResolvedTheme,
  type Theme,
} from "../lib/theme";

export type ThemeSnapshot = {
  /** What the user chose, including "system". */
  theme: Theme;
  /** What that actually renders as right now. */
  resolved: ResolvedTheme;
};

// Referentially stable, as `getServerSnapshot` requires. Which value it holds
// barely matters: the inline script in <head> has already set the real class on
// <html> before first paint, so CSS is correct regardless. This only decides the
// first React-rendered value of theme-dependent *props* (Monaco's theme name,
// Clerk's appearance), both of which resolve asynchronously anyway.
const SERVER_SNAPSHOT: ThemeSnapshot = { theme: "system", resolved: "dark" };

let snapshot: ThemeSnapshot | null = null;
const listeners = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;

function getSnapshot(): ThemeSnapshot {
  if (!snapshot) {
    const theme = readStoredTheme();
    snapshot = { theme, resolved: resolveTheme(theme) };
  }
  return snapshot;
}

function getServerSnapshot(): ThemeSnapshot {
  return SERVER_SNAPSHOT;
}

function commit(theme: Theme): void {
  const next: ThemeSnapshot = { theme, resolved: resolveTheme(theme) };
  // Bail if nothing changed, so an OS change while on an explicit theme doesn't
  // wake every subscriber for no reason.
  if (snapshot && snapshot.theme === next.theme && snapshot.resolved === next.resolved) {
    return;
  }
  snapshot = next;
  applyTheme(next.resolved);
  listeners.forEach((listener) => listener());
}

/** Keeps a "system" user tracking the OS after the page has loaded. */
function handleSystemChange(): void {
  if (getSnapshot().theme !== "system") return;
  commit("system");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!mediaQuery) {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", handleSystemChange);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function setTheme(theme: Theme): void {
  storeTheme(theme);
  commit(theme);
}

const ThemeContext = createContext<ThemeSnapshot>(SERVER_SNAPSHOT);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeSnapshot & { setTheme: typeof setTheme } {
  const value = useContext(ThemeContext);
  return { ...value, setTheme };
}
