"use client";

import IdentityDialog from "@/components/ui/IdentityDialog";
import { signedInUser, useClerkIdentity } from "@/lib/clerkIdentity";
import { setActiveUser } from "@/lib/user";

/**
 * The name prompt shown when someone reaches a room without an identity — a
 * deep link, or the landing page's Join button.
 *
 * There is no onCancel: there is nowhere to fall back to, and the room stays
 * disconnected until a name is entered.
 *
 * The dialog must NEVER wait on Clerk. Gating it on `isLoaded` looks right —
 * the prefill is read in a lazy initializer that runs once — but it makes
 * joining a room depend on a third-party script: verified by deep-linking into
 * a room from a fresh browser profile, where the prompt never appeared and the
 * room could not be joined at all. Instead the dialog renders immediately and
 * the `key` remounts it once if a signed-in session resolves later. A guest's
 * key never changes, so the common path never remounts and nothing typed is
 * ever lost.
 *
 * Clerk is read here rather than in `CodeEditor` because this is the only thing
 * that uses it: a tab that already has an identity connects to the room without
 * ever touching Clerk.
 */
export default function JoinRoomPrompt() {
  const clerkUser = signedInUser(useClerkIdentity());

  return (
    <IdentityDialog
      key={clerkUser ? "clerk" : "guest"}
      title="Join this room"
      description="Pick a name so everyone can tell your cursor apart."
      submitLabel="Join Room"
      onSubmit={setActiveUser}
      clerkUserId={clerkUser?.clerkUserId}
      clerkPrefill={
        clerkUser
          ? { firstName: clerkUser.firstName, lastName: clerkUser.lastName }
          : null
      }
      signedInAs={clerkUser?.label}
    />
  );
}
