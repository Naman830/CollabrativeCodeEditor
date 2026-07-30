"use server";

// INVARIANT: a Server Function is a public POST and `proxy.ts` protects nothing — the user must be
// re-read from the session here, never taken from the client.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { deleteDeadRoomForUser } from "@/lib/data/deadRooms";

export type DeleteSnapshotResult = { ok: false; message: string };

// INVARIANT: `revalidatePath` before `redirect` — `redirect` throws, so anything after it is dead.
// INVARIANT: failures return a message, never throw — a throw lands in `error.tsx`, which is
// copy about a failed *read*.
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
    return { ok: false, message: "Couldn't reach the database. Please try again." };
  }

  if (!deleted) {
    // INVARIANT: one answer for "no such snapshot" and "not yours" — no existence oracle.
    return { ok: false, message: "That snapshot is no longer on your profile." };
  }

  revalidatePath("/profile");
  redirect("/profile");
}
