"use client";

// The one place the app learns about Clerk, in the same spirit as
// `lib/collab/awareness.ts` (the one boundary for untrusted peer state) and
// `lib/editor/languages.ts` (the one language enumeration). Everything else imports
// `useClerkIdentity` and never touches `useUser` directly, so the shape Clerk
// hands us is normalised exactly once.

import { useAuth, useUser } from "@clerk/nextjs";
import { useCallback } from "react";
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

/** The signed-in case on its own, for callers that only care about the prefill. */
export type SignedInClerkUser = Extract<ClerkIdentity, { signedIn: true }>;

/**
 * Narrows to the signed-in case, or null for "guest, or Clerk hasn't answered".
 *
 * Collapsing those two into one null is deliberate: no caller may treat "not
 * loaded yet" as a reason to withhold UI. Blocking the identity dialog on Clerk
 * made a deep-linked room unjoinable when the script was slow — the prompt
 * never rendered and there was no way in.
 */
export function signedInUser(identity: ClerkIdentity): SignedInClerkUser | null {
  return identity.ready && identity.signedIn ? identity : null;
}

/**
 * How long a caller may wait for Clerk to produce a token before giving up.
 *
 * There is always a "no token" answer, so nothing this gates can fail — see
 * `useClerkToken` below.
 */
const TOKEN_TIMEOUT_MS = 2000;

/**
 * Returns a stable getter for the current Clerk session token, or null.
 *
 * This is the sanctioned way for the sync server to learn who is signed in.
 * `clerkUserId` deliberately never enters awareness (see `hooks/useCollabRoom.ts`)
 * because awareness is peer-controlled and an account ID broadcast there is a
 * claim anyone can forge — and task 7.3 keys saved room snapshots on an account,
 * so a forged one would write a room's code into a stranger's profile. A token
 * the server verifies is the only trustworthy channel.
 *
 * **It never rejects and never hangs.** A guest, a signed-in user whose Clerk
 * script has not loaded, a network failure and a slow response all resolve to
 * null within {@link TOKEN_TIMEOUT_MS}. That matters because the caller opens the
 * WebSocket: this file already learned once — see `signedInUser` above — that
 * gating UI on Clerk resolving left a deep-linked room unjoinable, and gating the
 * *socket* on it would be the same bug one layer down.
 */
export function useClerkToken(): () => Promise<string | null> {
  const { getToken } = useAuth();

  return useCallback(async () => {
    try {
      return await Promise.race([
        getToken(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS)),
      ]);
    } catch {
      return null;
    }
  }, [getToken]);
}

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
