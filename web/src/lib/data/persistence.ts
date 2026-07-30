// INVARIANT: an ESTIMATE of §6.1's server-side verdict, about you and never about the room —
// the wording must always promise less than the server guarantees. See CLAUDE.md.

// Keep in sync with MEMBER_MIN_CONNECTED_MS in server/src/rooms/state.js, whose value is
// env-overridable there, so the two can disagree at runtime with nothing to detect it.
export const MEMBER_MIN_CONNECTED_MS = 60_000;

export type PersistenceStatus =
  | "guest"
  | "idle"
  | "pending"
  | "saving";

type Copy = { label: string; detail: string };

const COPY: Record<PersistenceStatus, Copy> = {
  guest: {
    label: "Guest · nothing is saved",
    detail:
      "You are not signed in, so nothing from this room is kept. Sign in before the room closes to keep a copy on your profile.",
  },
  idle: {
    label: "Not saved yet",
    detail:
      "Signed in, but you have not edited anything yet. A room is only kept for people who worked in it.",
  },
  pending: {
    label: "Not saved yet",
    detail:
      "Signed in and editing. Stay in the room a little longer and a read-only copy should reach your profile when it closes.",
  },
  saving: {
    label: "Saving to your profile",
    detail:
      "Signed in, editing, and here long enough — a read-only copy should reach your profile when this room closes.",
  },
};

export function persistenceCopy(status: PersistenceStatus): Copy {
  return COPY[status];
}

// `remainingMs` is only meaningful for `"pending"`.
export function persistenceLabel(status: PersistenceStatus, remainingMs: number): string {
  const { label } = COPY[status];
  if (status !== "pending") return label;
  return `${label} · ${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}
