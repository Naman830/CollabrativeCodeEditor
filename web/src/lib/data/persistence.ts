// Whether the room you are in looks like it will end up on your profile
// (tasks.md §10.8's "in-room persistence indicator").
//
// ---------------------------------------------------------------------------
// This is an ESTIMATE, and the wording must keep promising less than the server
// guarantees. The client cannot know the real answer:
//
//   - The threshold (§6.1) is evaluated in `server/src/rooms/state.js` against a Clerk
//     token the *server* verified. A token that silently failed verification —
//     an outage, an unset `CLERK_SECRET_KEY`, a clock skew — leaves a perfectly
//     healthy-looking socket and no membership at all.
//   - The server counts connected time refcounted across every socket of that
//     account, including a second tab; a single tab's wall clock cannot
//     reproduce that.
//   - Whether the *room* is saved depends on any participant qualifying, and
//     awareness deliberately carries no account IDs (see CLAUDE.md, "Accounts
//     (Clerk)"), so the client cannot see other people's status at all.
//
// Hence the chip speaks only about **you**, never about the room, and the
// client's did-edit half is stricter than the server's — see the origin filter
// in `hooks/useCollabRoom.ts`. Both keep the error on the safe side: it may fail
// to promise a save that happens, never the reverse.
// ---------------------------------------------------------------------------
//
// The constant below is the **fifth** hand-maintained duplication across the two
// workspaces, after `rateLimit.js`/`rateLimit.ts`, `CLOSE_ROOM_NOT_FOUND`,
// `rooms/state.js`'s copies of `sanitizeName`/`HEX_COLOR`, and
// `TRUNCATION_MARKER`. It is worse than those in one way: the server's value is
// env-overridable (`MEMBER_MIN_CONNECTED_MS` in `server/.env`), so the two can
// legitimately disagree at runtime with nothing to detect it. One more reason
// the chip is worded as an estimate rather than a promise.

/** Mirrors `MEMBER_MIN_CONNECTED_MS`'s default in `server/src/rooms/state.js`. */
export const MEMBER_MIN_CONNECTED_MS = 60_000;

export type PersistenceStatus =
  /** Not signed in. Nothing is stored, exactly as in v1. */
  | "guest"
  /** Signed in, but this client has not edited anything yet. */
  | "idle"
  /** Signed in and editing, but still short of the connected-time threshold. */
  | "pending"
  /** Signed in, edited, and past the threshold. */
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

/**
 * The label, with the remaining countdown appended while one is running.
 * `remainingMs` is only meaningful for `"pending"`.
 */
export function persistenceLabel(status: PersistenceStatus, remainingMs: number): string {
  const { label } = COPY[status];
  if (status !== "pending") return label;
  return `${label} · ${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}
