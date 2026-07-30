"use client";

// INVARIANT: an estimate about *you*, never a promise about the room — see
// `lib/data/persistence.ts`. Holds the leaving warning's real sentence, since
// browsers ignore custom `beforeunload` text.

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
      // Focusable so the tooltip, which holds the whole explanation, is keyboard-reachable.
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
      {/* Hidden when narrow: the dot plus the accessible name still carry the state. */}
      <span className="hidden truncate md:inline">{label}</span>
    </span>
  );
}
