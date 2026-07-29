// tasks.md §7.4: every dead room this account may still read.
//
// Protected in the page, not in `proxy.ts`. `clerkMiddleware()` is called with no
// callback on purpose so the guest flow keeps reaching `/`, `/room/*` and
// `/api/execute`, and Clerk now deprecates `createRouteMatcher` in favour of
// exactly this — "move auth checks into each page, layout, API route, or Server
// Function that accesses protected data".
//
// No `export const dynamic = "force-dynamic"` is needed: `auth()` reads
// `headers()` internally, which opts the route into dynamic rendering by itself.

import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import DeadRoomCard from "../components/DeadRoomCard";
import ProfileShell, { ProfilePanel, ProfileSignInGate } from "../components/ProfileShell";
import { ArchiveIcon } from "../components/icons";
import { listDeadRoomsForUser } from "../lib/deadRooms";

export const metadata: Metadata = {
  title: "Your rooms · Collaborative Code Editor",
  description: "Read-only snapshots of the rooms you worked in.",
};

export default async function ProfilePage() {
  const { userId } = await auth();
  if (!userId) return <ProfileSignInGate />;

  const { rooms, capped } = await listDeadRoomsForUser(userId);

  return (
    <ProfileShell backHref="/" backLabel="Home">
      <div className="mb-6 flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Your rooms</h1>
        <p className="text-sm text-zinc-400">
          When a room closes, its final code is saved once and kept here.{" "}
          <span className="text-zinc-300">Read-only</span> — a closed room can never be run
          or rejoined.
        </p>
      </div>

      {rooms.length === 0 ? (
        <ProfilePanel icon={<ArchiveIcon className="h-5 w-5" />} title="No saved rooms yet">
          {/* Both halves of tasks.md §6.1's contribution threshold, spelled out:
              an empty profile is far more often "the rules were not met" than
              "nothing was saved", and a page that does not say so reads as
              broken. */}
          <p className="text-sm text-zinc-400">
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

          {/* Never cap silently. */}
          {capped && (
            <p className="mt-4 text-center text-xs text-zinc-500">
              Showing your {rooms.length} most recent rooms. Older ones are still saved but
              are not listed here.
            </p>
          )}
        </>
      )}
    </ProfileShell>
  );
}
