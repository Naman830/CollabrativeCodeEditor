"use client";

// The one place the app learns about Clerk, in the same spirit as
// `lib/awareness.ts` (the one boundary for untrusted peer state) and
// `lib/languages.ts` (the one language enumeration). Everything else imports
// `useClerkIdentity` and never touches `useUser` directly, so the shape Clerk
// hands us is normalised exactly once.

import { useUser } from "@clerk/nextjs";
import { sanitizeName } from "./user";

export type ClerkIdentity =
  /**
   * Clerk hasn't resolved the session yet. Distinct from signed-out on purpose:
   * `IdentityDialog` reads its prefill in lazy `useState` initializers that run
   * exactly once, so a dialog opened during this state would capture an empty
   * name and never fill in. Callers must hold the dialog closed until `ready`.
   */
  | { ready: false }
  | { ready: true; signedIn: false }
  | {
      ready: true;
      signedIn: true;
      clerkUserId: string;
      /** Sanitized; either part may be "" — a Clerk profile needn't have both. */
      firstName: string;
      lastName: string;
      /** Email or username, for the dialog's "Signed in as …" line. */
      label: string;
    };

export function useClerkIdentity(): ClerkIdentity {
  const { isLoaded, isSignedIn, user } = useUser();

  if (!isLoaded) return { ready: false };
  if (!isSignedIn || !user) return { ready: true, signedIn: false };

  return {
    ready: true,
    signedIn: true,
    clerkUserId: user.id,
    // Through `sanitizeName` like any other name: these end up in a CSS
    // `content:` string above a caret, and a Clerk profile is free to hold a
    // 200-character name that would wreck the layout.
    firstName: sanitizeName(user.firstName ?? ""),
    lastName: sanitizeName(user.lastName ?? ""),
    label:
      user.primaryEmailAddress?.emailAddress ??
      user.username ??
      user.id,
  };
}
