"use client";

// INVARIANT: an external store, never useState + useEffect — the server snapshot
// must legitimately differ from the client's (same pattern as lib/collab/user.ts).

import { createContext, useContext, useSyncExternalStore } from "react";
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type ResolvedTheme,
  type Theme,
} from "@/lib/theme";

export type ThemeSnapshot = {
  theme: Theme;
  resolved: ResolvedTheme;
};

// INVARIANT: referentially stable, as `getServerSnapshot` requires.
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
  // Bail if unchanged, so an OS change on an explicit theme wakes no subscriber.
  if (snapshot && snapshot.theme === next.theme && snapshot.resolved === next.resolved) {
    return;
  }
  snapshot = next;
  applyTheme(next.resolved);
  listeners.forEach((listener) => listener());
}

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
