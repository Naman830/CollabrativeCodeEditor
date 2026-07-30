"use client";

// INVARIANT: the one boundary between Clerk and the app — nothing else may import
// `useUser` or `useAuth`, so Clerk's shape is normalised exactly once.

import { useAuth, useUser } from "@clerk/nextjs";
import { useCallback } from "react";
import { sanitizeName } from "./user";

export type ClerkIdentity =
  // Not signed-out: the session is unresolved, and a prefill read in a lazy
  // initializer during this state would capture an empty name and never fill in.
  | { ready: false }
  | { ready: true; signedIn: false }
  | {
      ready: true;
      signedIn: true;
      clerkUserId: string;
      // Either part may be "" — a Clerk profile needn't have both.
      firstName: string;
      lastName: string;
      label: string;
    };

export type SignedInClerkUser = Extract<ClerkIdentity, { signedIn: true }>;

// INVARIANT: "guest" and "not loaded yet" collapse into one null, so no caller can
// withhold UI until Clerk answers — that left deep-linked rooms unjoinable.
export function signedInUser(identity: ClerkIdentity): SignedInClerkUser | null {
  return identity.ready && identity.signedIn ? identity : null;
}

const TOKEN_TIMEOUT_MS = 2000;

// The only trustworthy channel for the sync server to learn who is signed in — an
// account ID must never travel through peer-controlled awareness instead.
// INVARIANT: never rejects, never hangs; always resolves within TOKEN_TIMEOUT_MS,
// because the caller opens the WebSocket and must not be gated on Clerk.
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
    // Sanitized like any other name: a Clerk profile may hold a 200-character one.
    firstName: sanitizeName(user.firstName ?? ""),
    lastName: sanitizeName(user.lastName ?? ""),
    label:
      user.primaryEmailAddress?.emailAddress ??
      user.username ??
      user.id,
  };
}
