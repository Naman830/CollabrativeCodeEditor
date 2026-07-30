"use client";

// INVARIANT: Clerk parses `appearance.variables` at runtime, so they must be
// literal hex, never `var()`. Keep in step with styles/globals.css.

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
    // INVARIANT: `variables` only, never @clerk/ui's `dark` theme — that is a
    // second runtime bundle, and it fails to load on the room route.
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
