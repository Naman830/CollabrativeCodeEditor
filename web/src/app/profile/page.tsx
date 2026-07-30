// INVARIANT: auth is checked here, not in `proxy.ts` — `clerkMiddleware()` stays callback-free so
// `/`, `/room/*` and `/api/execute` remain public.

import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import DeadRoomCard from "@/components/profile/DeadRoomCard";
import ProfileShell, { ProfilePanel, ProfileSignInGate } from "@/components/layout/ProfileShell";
import { ArchiveIcon } from "@/components/ui/icons";
import { listDeadRoomsForUser } from "@/lib/data/deadRooms";

export const metadata: Metadata = {
  title: "Your rooms",
  description: "Read-only snapshots of the rooms you worked in.",
};

export default async function ProfilePage() {
  const { userId } = await auth();
  if (!userId) return <ProfileSignInGate />;

  const { rooms, capped } = await listDeadRoomsForUser(userId);

  return (
    <ProfileShell backHref="/" backLabel="Home">
      <div className="mb-6 flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Your rooms</h1>
        <p className="text-sm text-fg-muted">
          When a room closes, its final code is saved once and kept here.{" "}
          <span className="text-fg">Read-only</span> — a closed room can never be run
          or rejoined.
        </p>
      </div>

      {rooms.length === 0 ? (
        <ProfilePanel icon={<ArchiveIcon className="h-5 w-5" />} title="No saved rooms yet">
          <p className="text-sm text-fg-muted">
            A room is saved to your profile when it closes — but only if you were signed in,
            stayed at least a minute, and actually edited the code. Rooms where everyone was
            a guest are never saved at all.
          </p>
        </ProfilePanel>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {rooms.map((room) => (
              <DeadRoomCard key={room.id} room={room} />
            ))}
          </ul>

          {capped && (
            <p className="mt-4 text-center text-xs text-fg-muted">
              Showing your {rooms.length} most recent rooms. Older ones are still saved but
              are not listed here.
            </p>
          )}
        </>
      )}
    </ProfileShell>
  );
}
