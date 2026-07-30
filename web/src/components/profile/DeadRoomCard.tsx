// One row in the profile listing.
//
// Server-rendered, and it must stay that way: it imports `lib/data/deadRooms.ts`,
// which reaches `lib/data/db.ts`. Only the formatting helpers are used here, but the
// module graph is what counts.

import Link from "next/link";
import {
  absoluteTime,
  lifetime,
  relativeTime,
  type DeadRoomSummary,
} from "@/lib/data/deadRooms";
import { ArchiveIcon, LockIcon } from "@/components/ui/icons";

/**
 * There is no room *name* to show.
 *
 * tasks.md §7.4 asks for "room name/date/language", but `dead_rooms` has no name
 * column and never had one — a room is minted by `POST /rooms` as a bare UUID and
 * nobody ever titles it. The original room ID is therefore the name, shown in
 * full-width mono so it is recognisable against a link someone still has open in
 * another tab.
 */
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
            {/* Null on every row today, and honestly so: the language dropdown is
                a per-user editing preference kept off the shared Y.Doc, so the
                server has no single answer to record until tasks.md §10.1 moves
                the selector to room creation. */}
            <dd>{room.language ?? "not recorded"}</dd>
          </div>
        </dl>
      </Link>
    </li>
  );
}
