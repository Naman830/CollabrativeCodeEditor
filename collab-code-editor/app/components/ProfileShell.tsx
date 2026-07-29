// The chrome shared by every /profile screen: the page frame, the header, the
// signed-out gate, and the centred panel that the empty, not-found and error
// states all reuse.
//
// No `"use client"` and no import of `lib/deadRooms.ts`: `error.tsx` is a Client
// Component and imports `ProfilePanel` from here, so nothing in this file may
// reach the database. Clerk's `UserButton`/`SignInButton` are Client Components
// themselves, which a Server Component may render as long as it passes no
// function props — and these take only element children.

import Link from "next/link";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { ArrowLeftIcon } from "./icons";

/** The two button styles used across these screens. Same values as `RoomGate`. */
export const primaryButton =
  "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-lg shadow-accent/20 transition-colors hover:bg-accent-strong";
export const secondaryButton =
  "rounded-lg border border-edge bg-raised px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-[#2c2c2c]";

/** The badge above a panel's heading. Matches `RoomGate`'s `GateIcon`. */
export function PanelIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-raised text-zinc-400">
      {children}
    </span>
  );
}

/**
 * A centred card. The empty profile, the missing snapshot, the signed-out gate
 * and the database error all wear the same shape, because they are all "here is
 * why there is nothing to show you, and here is the way out".
 */
export function ProfilePanel({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative mx-auto flex max-w-sm flex-col items-center gap-4 rounded-2xl border border-edge bg-panel/80 p-8 text-center shadow-2xl shadow-black/40 backdrop-blur">
      <PanelIcon>{icon}</PanelIcon>
      <h2 className="text-xl font-semibold text-zinc-50">{title}</h2>
      {children}
    </div>
  );
}

type ProfileShellProps = {
  children: React.ReactNode;
  /** Where the back link points. The list for a snapshot, home for the list. */
  backHref: string;
  backLabel: string;
  /** Hidden for a signed-out visitor, who has no account chip to show. */
  showAccount?: boolean;
};

/** The page frame: background wash, back link, account chip, content. */
export default function ProfileShell({
  children,
  backHref,
  backLabel,
  showAccount = true,
}: ProfileShellProps) {
  return (
    <main className="relative flex-1 overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(55rem_35rem_at_50%_-15%,rgba(76,141,255,0.12),transparent_70%)]"
      />

      <div className="relative mx-auto w-full max-w-3xl">
        <div className="mb-8 flex items-center gap-3">
          <Link
            href={backHref}
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-panel/60 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-raised"
          >
            <ArrowLeftIcon />
            {backLabel}
          </Link>
          {showAccount && (
            <span className="ml-auto flex items-center">
              <UserButton />
            </span>
          )}
        </div>

        {children}
      </div>
    </main>
  );
}

/**
 * What a signed-out visitor gets instead of the profile.
 *
 * Deliberately not `redirect("/")` and not `auth.protect()`. There is no
 * `/sign-in` route in this app — signing in is a modal, offered from the landing
 * page — so `auth.protect()` would eject the visitor to Clerk's hosted Account
 * Portal, and a bare redirect turns a shared `/profile` link into a silent
 * bounce with no explanation. The gate keeps the deep link working: sign in in
 * place, and the page you asked for is the page you land on.
 */
export function ProfileSignInGate() {
  return (
    <ProfileShell backHref="/" backLabel="Home" showAccount={false}>
      <ProfilePanel
        icon={
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
            <path d="M5 20a7 7 0 0 1 14 0" />
          </svg>
        }
        title="Sign in to see your rooms"
      >
        <p className="text-sm text-zinc-400">
          Saved rooms belong to an account. Guests can create, join and run code exactly as
          before — nothing is stored for them, so there is nothing here to show.
        </p>
        <SignInButton mode="modal">
          <button type="button" className={primaryButton}>
            Sign in
          </button>
        </SignInButton>
      </ProfilePanel>
    </ProfileShell>
  );
}
