// The chrome shared by every /profile screen: the page frame, the nav, the
// signed-out gate, and the centred panel that the empty, not-found and error
// states all reuse.
//
// No `"use client"` and no import of `lib/deadRooms.ts`: `error.tsx` is a Client
// Component and imports `ProfilePanel` from here, so nothing in this file may
// reach the database. Clerk's `SignInButton` and `SiteNav` are Client Components
// themselves, which a Server Component may render as long as it passes no
// function props — and these take only element children and strings.
//
// The button styles used to be declared here *and* byte-for-byte again in
// `RoomGate.tsx`. They now live once, in `lib/ui.ts`.

import { SignInButton } from "@clerk/nextjs";
import SiteNav from "./SiteNav";
import { UserIcon } from "./icons";
import { card, primaryButton } from "../lib/ui";

/** The badge above a panel's heading. Matches `RoomGate`'s `GateIcon`. */
export function PanelIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-raised text-fg-muted">
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
    <div className={`relative mx-auto flex max-w-sm flex-col items-center gap-4 p-8 text-center ${card}`}>
      <PanelIcon>{icon}</PanelIcon>
      <h2 className="text-xl font-semibold text-fg">{title}</h2>
      {children}
    </div>
  );
}

type ProfileShellProps = {
  children: React.ReactNode;
  /** Where the back link points. The list for a snapshot, home for the list. */
  backHref: string;
  backLabel: string;
};

/** The page frame: nav, background wash, content. */
export default function ProfileShell({ children, backHref, backLabel }: ProfileShellProps) {
  return (
    <>
      <SiteNav backHref={backHref} backLabel={backLabel} />
      <main className="wash relative flex-1 px-4 py-10">
        <div className="relative mx-auto w-full max-w-3xl">{children}</div>
      </main>
    </>
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
    <ProfileShell backHref="/" backLabel="Home">
      <ProfilePanel icon={<UserIcon className="h-5 w-5" />} title="Sign in to see your rooms">
        <p className="text-sm text-fg-muted">
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
