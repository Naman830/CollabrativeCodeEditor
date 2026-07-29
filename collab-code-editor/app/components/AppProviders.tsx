"use client";

// ThemeProvider wraps ClerkProvider so Clerk's `appearance` can react to the
// theme. Clerk's own UI (the UserButton dropdown, the sign-in/sign-up modals) is
// the one surface our CSS variables cannot reach.
//
// Why literal hexes and not `var(--panel)`: Clerk *parses* these colours at
// runtime to derive its own shades and alpha variants (`@clerk/shared`'s
// `stringToHslaColor` / `hexStringToRgbaColor`). A `var()` reference is not a
// parseable colour, so Clerk would silently fall back to broken defaults.
// Literals it is — which is exactly why the provider has to move client-side,
// since only the client knows which theme is active.
//
// Moving ClerkProvider out of the server layout costs nothing here, and that is
// checked rather than assumed: `@clerk/nextjs`'s server ClerkProvider only
// computes `initialState` when passed a `dynamic` prop, which this app has never
// done — it already delegated straight to the client provider. Keyless mode
// (the throwaway `.clerk/` instance used when no keys are set) is handled on the
// client path too.
//
// Keep these values in step with `app/globals.css`.

import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider, useTheme } from "./ThemeProvider";

const CLERK_DARK = {
  colorPrimary: "#4c8dff",
  colorBackground: "#131519",
  colorForeground: "#e8eaed",
  colorInput: "#1a1d22",
  colorInputForeground: "#e8eaed",
  colorNeutral: "#ffffff",
  colorBorder: "#24282f",
} as const;

const CLERK_LIGHT = {
  colorPrimary: "#2563eb",
  colorBackground: "#ffffff",
  colorForeground: "#14171c",
  colorInput: "#f1f3f6",
  colorInputForeground: "#14171c",
  colorNeutral: "#000000",
  colorBorder: "#e2e5ea",
} as const;

function ClerkWithTheme({ children }: { children: React.ReactNode }) {
  const { resolved } = useTheme();

  return (
    // Deliberately NOT the `dark` theme from `@clerk/ui`: that theme is a
    // separate runtime bundle Clerk fetches from its CDN, and on the room route
    // Monaco's loader used to install a global `define.amd`, which made that UMD
    // bundle register itself as an AMD module instead of executing. Clerk then
    // failed with `failed_to_load_clerk_ui` and a signed-in user deep-linking
    // into a room silently got no session. These variables ship inside clerk-js
    // itself and need no second bundle.
    <ClerkProvider
      appearance={{ variables: resolved === "dark" ? { ...CLERK_DARK } : { ...CLERK_LIGHT } }}
    >
      {children}
    </ClerkProvider>
  );
}

export default function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ClerkWithTheme>{children}</ClerkWithTheme>
    </ThemeProvider>
  );
}
