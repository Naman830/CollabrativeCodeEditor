// INVARIANT: must stay server-rendered — it imports `lib/data/deadRooms.ts`, which reaches `db.ts`.

import Link from "next/link";
import {
  absoluteTime,
  lifetime,
  relativeTime,
  type DeadRoomSummary,
} from "@/lib/data/deadRooms";
import { ArchiveIcon, LockIcon } from "@/components/ui/icons";

// `dead_rooms` has no name column, so the original room id is the title.
export default function DeadRoomCard({ room }: { room: DeadRoomSummary }) {
  return (
    <li>
      <Link
        href={`/profile/${room.id}`}
        className="group flex flex-col gap-3 rounded-2xl border border-edge bg-panel/80 p-5 shadow-lg shadow-[var(--shadow-color)] transition-colors hover:border-edge-strong hover:bg-panel focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 text-fg-muted transition-colors group-hover:text-fg">
            <ArchiveIcon className="h-4 w-4" />
          </span>
          <span className="truncate font-mono text-sm text-fg">{room.roomId}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-edge bg-raised/60 px-2.5 py-1 text-[11px] text-fg-muted">
            <LockIcon className="h-3 w-3" />
            Closed
          </span>
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
            <dt className="text-fg-subtle">Lasted</dt>
            <dd>{lifetime(room.createdAt, room.diedAt)}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-fg-subtle">Language</dt>
            {/* Null for rows written before §10.1, which had no room-wide language. */}
            <dd>{room.language ?? "not recorded"}</dd>
          </div>
        </dl>
      </Link>
    </li>
  );
}
