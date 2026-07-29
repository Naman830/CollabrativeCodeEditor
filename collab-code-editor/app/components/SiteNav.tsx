"use client";

// The top bar for every screen that is not the room: the landing page and both
// /profile screens. The room has its own denser `RoomChrome` instead.
//
// A Client Component, because the theme toggle and Clerk's session both are.
// `ProfileShell` is a Server Component and renders this — which is fine, since
// it passes only strings.

import Link from "next/link";
import { SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import ThemeToggle from "./ThemeToggle";
import { ArrowLeftIcon, LogoMark } from "./icons";
import { useClerkIdentity } from "../lib/clerkIdentity";
import { cn, focusRing } from "../lib/ui";

const navLink = cn(
  "rounded-lg border border-edge bg-panel/60 px-3 py-1.5 text-xs font-medium text-fg",
  "transition-colors hover:border-edge-strong hover:bg-raised",
  focusRing,
);

type SiteNavProps = {
  /** Renders a back link in place of the wordmark. Used by /profile. */
  backHref?: string;
  backLabel?: string;
};

export default function SiteNav({ backHref, backLabel }: SiteNavProps) {
  const clerk = useClerkIdentity();

  return (
    <header className="flex items-center gap-2 border-b border-edge bg-panel/60 px-4 py-3 backdrop-blur">
      {backHref ? (
        <Link href={backHref} className={cn(navLink, "inline-flex items-center gap-1.5")}>
          <ArrowLeftIcon />
          {backLabel}
        </Link>
      ) : (
        <Link
          href="/"
          className={cn("group inline-flex items-center gap-2 rounded-lg", focusRing)}
        >
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-strong text-white">
            <LogoMark className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-fg">Codesync</span>
        </Link>
      )}

      {/* Fixed height so the row does not jump when Clerk resolves and the
          buttons below swap in — the same reason the old landing page pinned
          its auth row to `h-8`. */}
      <nav className="ml-auto flex h-8 items-center gap-2">
        <ThemeToggle />

        {clerk.ready &&
          (clerk.signedIn ? (
            <>
              {/* The only way into /profile. Signed-out visitors get no link,
                  because they have nothing there and the page would only tell
                  them to sign in — which the buttons beside this already do. */}
              <Link href="/profile" className={navLink}>
                My rooms
              </Link>
              <UserButton />
            </>
          ) : (
            <>
              <SignInButton mode="modal">
                <button type="button" className={navLink}>
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button
                  type="button"
                  className={cn(
                    "rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-contrast",
                    "transition-colors hover:bg-accent-strong",
                    focusRing,
                  )}
                >
                  Sign up
                </button>
              </SignUpButton>
            </>
          ))}
      </nav>
    </header>
  );
}
