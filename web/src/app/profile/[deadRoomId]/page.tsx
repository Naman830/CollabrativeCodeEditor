// INVARIANT: the URL carries `dead_rooms.id`, not `room_id` — it is the membership row's key, so
// the authorization check and the index lookup are one query.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import DeleteSnapshotButton from "@/components/profile/DeleteSnapshotButton";
import ProfileShell, { ProfileSignInGate } from "@/components/layout/ProfileShell";
import SnapshotDownloadAll from "@/components/profile/SnapshotDownloadAll";
import SnapshotFile from "@/components/profile/SnapshotFile";
import { LockIcon } from "@/components/ui/icons";
import { absoluteTime, getDeadRoomForUser, lifetime, relativeTime } from "@/lib/data/deadRooms";
import { languageLabel } from "@/lib/editor/languages";

export const metadata: Metadata = {
  title: "Saved room",
  description: "A read-only snapshot of a room that has closed.",
};

// Run and Rejoin are rendered disabled, not omitted — omitting reads as unbuilt.
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

  // INVARIANT: membership-scoped — one null for "no such snapshot" and "not yours", no oracle.
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
            {/* Null for rows written before §10.1, which had no room-wide language. */}
            <dd>{room.language ? languageLabel(room.language) : "not recorded"}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-fg-subtle">Files</dt>
            <dd>{room.files.length}</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2 rounded-xl border border-edge bg-panel/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <DeadControl label="Run" reason="A closed room's code can never be run again." />
            <DeadControl label="Rejoin" reason="This room no longer exists on the server." />
            <DeleteSnapshotButton deadRoomId={room.id} roomId={room.roomId} />
            {room.files.length > 1 && <SnapshotDownloadAll files={room.files} />}
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

      <div className="flex flex-col gap-4">
        {room.files.map((file, index) => (
          <SnapshotFile key={`${index}-${file.filename}`} file={file} />
        ))}
      </div>
    </ProfileShell>
  );
}
