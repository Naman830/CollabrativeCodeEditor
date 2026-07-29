// One dead room, read-only. tasks.md §7.4's "clicking a room opens a read-only
// code view", plus §8's "no re-running, no re-joining, no editing in place".
//
// The URL carries `dead_rooms.id`, not `room_id`. Two reasons: the membership
// row's composite primary key is `(user_id, dead_room_id)`, so this id makes the
// authorization check and the index lookup the same query; and a `/profile/<id>`
// that shared its id with a live `/room/<id>` would invite exactly the confusion
// this page exists to prevent.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import ProfileShell, { ProfileSignInGate } from "../../components/ProfileShell";
import SnapshotFile from "../../components/SnapshotFile";
import { LockIcon } from "../../components/icons";
import { absoluteTime, getDeadRoomForUser, lifetime, relativeTime } from "../../lib/deadRooms";

export const metadata: Metadata = {
  title: "Saved room",
  description: "A read-only snapshot of a room that has closed.",
};

/**
 * Run and Rejoin are rendered *disabled*, not omitted.
 *
 * §7.4's last bullet says "explicitly disable/hide". Hiding them would be
 * indistinguishable from having forgotten to build them; a control that is
 * visibly off, with a reason attached, is the version that actually communicates
 * "this room is dead" to someone who used it while it was alive.
 */
function DeadControl({ label, reason }: { label: string; reason: string }) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      title={reason}
      className="cursor-not-allowed rounded-lg border border-edge bg-transparent px-3 py-1.5 text-xs font-medium text-fg-subtle line-through decoration-fg-subtle"
    >
      {label}
    </button>
  );
}

export default async function SnapshotPage(props: PageProps<"/profile/[deadRoomId]">) {
  const { userId } = await auth();
  if (!userId) return <ProfileSignInGate />;

  const { deadRoomId } = await props.params;

  // Membership-scoped: null covers "no such snapshot" and "not yours" with the
  // same answer, so the page cannot be used to probe which ids exist. See the
  // HARD RULE in `lib/deadRooms.ts`.
  const room = await getDeadRoomForUser(userId, deadRoomId);
  if (!room) notFound();

  return (
    <ProfileShell backHref="/profile" backLabel="Your rooms">
      <div className="mb-6 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="flex w-fit items-center gap-1.5 rounded-full border border-warning/40 bg-warning-soft px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-warning">
            <LockIcon className="h-3 w-3" />
            Closed room · read-only snapshot
          </span>
          <h1 className="break-all font-mono text-xl font-semibold text-fg">
            {room.roomId}
          </h1>
        </div>

        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-fg-muted">
          <div className="flex items-center gap-1.5">
            <dt className="text-fg-subtle">Closed</dt>
            <dd>
              <time dateTime={room.diedAt.toISOString()} title={absoluteTime(room.diedAt)}>
                {relativeTime(room.diedAt)}
              </time>
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-fg-subtle">Created</dt>
            <dd>
              <time
                dateTime={room.createdAt.toISOString()}
                title={absoluteTime(room.createdAt)}
              >
                {relativeTime(room.createdAt)}
              </time>
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-fg-subtle">Lasted</dt>
            <dd>{lifetime(room.createdAt, room.diedAt)}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-fg-subtle">Language</dt>
            <dd>{room.language ?? "not recorded"}</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2 rounded-xl border border-edge bg-panel/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <DeadControl label="Run" reason="A closed room's code can never be run again." />
            <DeadControl label="Rejoin" reason="This room no longer exists on the server." />
            <Link
              href="/"
              className="ml-auto rounded-lg border border-edge bg-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-edge-strong hover:bg-edge"
            >
              New room
            </Link>
          </div>
          <p className="text-xs text-fg-muted">
            The room was destroyed when the last person left. Copy the code into a new room to
            keep working on it.
          </p>
        </div>
      </div>

      {/* A loop over one file today. `files` has been an array since 7.2 so that
          §10.1's multi-file rooms need no migration — and no rewrite here. */}
      <div className="flex flex-col gap-4">
        {room.files.map((file, index) => (
          <SnapshotFile key={`${index}-${file.filename}`} file={file} />
        ))}
      </div>
    </ProfileShell>
  );
}
