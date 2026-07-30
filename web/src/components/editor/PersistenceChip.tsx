"use client";

// "Is anything I do here being kept?" — tasks.md §10.8's persistence indicator.
//
// Presentational: every value arrives as a prop, and the estimate itself is
// computed in `hooks/useRoomPersistence.ts`. See `lib/data/persistence.ts` for why
// this can only ever be an estimate and why it speaks about *you* rather than
// about the room.
//
// It is also where the leaving warning's actual sentence lives, because
// browsers ignore custom `beforeunload` text and show their own generic prompt.

import { LockIcon } from "@/components/ui/icons";
import {
  persistenceCopy,
  persistenceLabel,
  type PersistenceStatus,
} from "@/lib/data/persistence";
import { cn, focusRing } from "@/lib/ui";

const DOT: Record<PersistenceStatus, string> = {
  guest: "bg-fg-subtle",
  idle: "bg-fg-subtle",
  pending: "bg-warning",
  saving: "bg-success",
};

const LAST_PEER_NOTE =
  "You are the last person here — closing this tab closes the room for good.";

export default function PersistenceChip({
  status,
  remainingMs,
  isLastPeer,
}: {
  status: PersistenceStatus;
  remainingMs: number;
  isLastPeer: boolean;
}) {
  const label = persistenceLabel(status, remainingMs);
  const { detail } = persistenceCopy(status);
  const title = isLastPeer ? `${LAST_PEER_NOTE} ${detail}` : detail;

  return (
    <span
      // Focusable so the explanation is reachable by keyboard, since the whole
      // of it lives in the tooltip — the bar has no room for three sentences.
      tabIndex={0}
      role="status"
      title={title}
      aria-label={`${label}. ${title}`}
      className={cn(
        "flex min-w-0 shrink items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors",
        isLastPeer
          ? "border-warning/40 bg-warning-soft text-warning"
          : "border-edge bg-raised/60 text-fg-muted",
        focusRing,
      )}
    >
      {isLastPeer ? (
        <LockIcon className="h-3 w-3 shrink-0" />
      ) : (
        <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", DOT[status])} />
      )}
      {/* Hidden on the narrowest widths, where the dot plus the accessible name
          still carry the state and the chrome bar is already wrapping. */}
      <span className="hidden truncate md:inline">{label}</span>
    </span>
  );
}
