"use client";

import IdentityDialog from "@/components/ui/IdentityDialog";
import { signedInUser, useClerkIdentity } from "@/lib/collab/clerkIdentity";
import { setActiveUser } from "@/lib/collab/user";

// INVARIANT: never gate this dialog on Clerk loading, or the room cannot be joined
// at all. The `key` remounts it once if a signed-in session resolves late.
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
