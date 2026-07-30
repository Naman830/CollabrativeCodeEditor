"use server";

// The first Server Function in this repo (tasks.md §10.7).
//
// §10.7 asks for a Server Function rather than an API route: `/profile` is
// otherwise entirely server-rendered, and a route handler would mean a second
// reason to ship client JavaScript on top of the confirm dialog.
//
// A Server Function is a public POST endpoint, and `proxy.ts` deliberately
// protects nothing (`clerkMiddleware()` is callback-free so the guest flow keeps
// reaching `/`, `/room/*` and `/api/execute`). So the check lives here, in the
// resource — which is also exactly what Clerk's `createRouteMatcher`
// deprecation note tells you to do. Nothing from the client is trusted beyond
// the id: the user is re-read from the session, and `deleteDeadRoomForUser`
// keys on it.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { deleteDeadRoomForUser } from "../lib/deadRooms";

export type DeleteSnapshotResult = { ok: false; message: string };

/**
 * Delete one snapshot from the signed-in user's profile, then send them back to
 * the listing.
 *
 * On success this never returns: `redirect` throws for control flow, so the
 * `revalidatePath` above it is what makes the listing re-query rather than
 * serve the deleted row from the client router cache. On failure it returns a
 * message for the dialog to render — deliberately *not* a throw, because a
 * failed mutation would land in `app/profile/error.tsx`, whose sentence is
 * "Couldn't load your rooms" and is about a failed read.
 */
export async function deleteSnapshotAction(
  _prev: DeleteSnapshotResult | null,
  formData: FormData
): Promise<DeleteSnapshotResult> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, message: "You need to be signed in to delete a snapshot." };
  }

  const deadRoomId = formData.get("deadRoomId");
  if (typeof deadRoomId !== "string") {
    return { ok: false, message: "That snapshot could not be identified." };
  }

  let deleted: boolean;
  try {
    deleted = await deleteDeadRoomForUser(userId, deadRoomId);
  } catch {
    // Neon autosuspends an idle branch, so an unreachable database is a routine
    // way for this to fail rather than an exceptional one.
    return { ok: false, message: "Couldn't reach the database. Please try again." };
  }

  if (!deleted) {
    // Same answer for "no such snapshot" and "not yours" — see
    // `deleteDeadRoomForUser`.
    return { ok: false, message: "That snapshot is no longer on your profile." };
  }

  revalidatePath("/profile");
  redirect("/profile");
}
