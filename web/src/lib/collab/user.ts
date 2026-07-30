// A collaborator's identity: the name they typed and a colour we assigned. It
// never leaves the browser, and it is the whole user model for the live room —
// Clerk (see ./clerkIdentity.ts) sits alongside it rather than replacing it,
// because signing in is optional and the guest flow is unchanged from v1.

export type CollabUser = {
  firstName: string;
  lastName: string;
  color: string;
  /**
   * Clerk's user ID, present only when this identity was submitted while signed
   * in. Task 7.1 asks for it *on the client*, and client is where it stays: it
   * is deliberately absent from the awareness payload in `hooks/useCollabRoom.ts`,
   * because awareness is peer-controlled and any client could claim any ID
   * (see `lib/collab/awareness.ts`). Task 7.3 needs the sync server to know who was
   * signed in, and it will have to verify a Clerk token itself to find out —
   * this field can never be that source of truth.
   */
  clerkUserId?: string;
};

// Fixed palette so remote cursor colors stay legible on the vs-dark theme.
export const CURSOR_COLORS = [
  "#e57373",
  "#64b5f6",
  "#81c784",
  "#ffb74d",
  "#ba68c8",
  "#4dd0e1",
  "#f06292",
  "#a1887f",
];

const SESSION_KEY = "collabcode:user";
const PREFILL_KEY = "collabcode:name";

const MAX_NAME_LENGTH = 24;

export function randomColor(): string {
  return CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
}

/**
 * Anything that cannot survive a trip into Postgres. Kept in step by hand with
 * `UNSTORABLE` in `server/src/rooms/state.js`, which is the copy that matters: a
 * participant name reaches `dead_room_members`' sibling `participants` column,
 * and one unpaired surrogate there makes `JSON.stringify` emit a bare `\ud83d`,
 * which Postgres rejects with `unsupported Unicode escape sequence` — taking
 * the room's whole snapshot with it. Stripped here too so the two copies do not
 * drift, and because a lone surrogate in a cursor label renders as a stray
 * replacement character anyway.
 */
const UNSTORABLE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Names end up in a CSS `content:` string above a caret, so keep them to one
 * line of printable text. A UX guard, not the security boundary — remote names
 * never pass through here, so `lib/collab/awareness.ts` is what has to hold.
 *
 * The cut is by code *point*: `.slice(0, 24)` counts UTF-16 code units and can
 * halve a surrogate pair, which is the one way this function could manufacture
 * the character {@link UNSTORABLE} exists to remove.
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(UNSTORABLE, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, MAX_NAME_LENGTH).join("");
}

/** "Naman Gupta" -> "Naman G." — short enough to sit above a caret. */
export function displayName(user: CollabUser): string {
  const initial = user.lastName.charAt(0).toUpperCase();
  return initial ? `${user.firstName} ${initial}.` : user.firstName;
}

/**
 * "Naman Gupta" -> "NG" — for the user bar's avatar chips. Takes only the name
 * parts, since the bar also builds chips for peers whose colour isn't trusted.
 */
export function initials(user: { firstName: string; lastName: string }): string {
  return (
    user.firstName.charAt(0) + user.lastName.charAt(0)
  ).toUpperCase();
}

function isValidUser(value: unknown): value is CollabUser {
  if (typeof value !== "object" || value === null) return false;
  const { firstName, lastName, color, clerkUserId } = value as Record<string, unknown>;
  return (
    typeof firstName === "string" &&
    typeof lastName === "string" &&
    typeof color === "string" &&
    sanitizeName(firstName).length > 0 &&
    sanitizeName(lastName).length > 0 &&
    CURSOR_COLORS.includes(color) &&
    // Optional, and must stay optional: every guest record — including every
    // one already sitting in someone's sessionStorage from v1 — has no such
    // field, and rejecting those would log the whole world out on first load.
    (clerkUserId === undefined || typeof clerkUserId === "string")
  );
}

/**
 * sessionStorage, not localStorage, on purpose: each tab gets its own user, so
 * a second tab on the same room is a genuinely separate collaborator.
 */
function loadSessionUser(): CollabUser | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidUser(parsed)) return null;
    return {
      firstName: sanitizeName(parsed.firstName),
      lastName: sanitizeName(parsed.lastName),
      color: parsed.color,
      clerkUserId: parsed.clerkUserId,
    };
  } catch {
    // Malformed JSON, or storage blocked (Safari private mode throws). Either
    // way: no identity yet.
    return null;
  }
}

function saveSessionUser(user: CollabUser): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch {
    // Non-fatal: the identity survives in memory, just not across a refresh.
  }
}

/**
 * Only the name is mirrored to localStorage, purely to prefill the form next
 * visit. The colour is left out so each session re-rolls one and two tabs stay
 * visually distinct.
 */
export function loadNamePrefill(): { firstName: string; lastName: string } | null {
  try {
    const raw = localStorage.getItem(PREFILL_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { firstName, lastName } = parsed as Record<string, unknown>;
    if (typeof firstName !== "string" || typeof lastName !== "string") return null;
    return {
      firstName: sanitizeName(firstName),
      lastName: sanitizeName(lastName),
    };
  } catch {
    return null;
  }
}

function saveNamePrefill(firstName: string, lastName: string): void {
  try {
    localStorage.setItem(PREFILL_KEY, JSON.stringify({ firstName, lastName }));
  } catch {
    // Non-fatal — the user just retypes their name next visit.
  }
}

// --- Identity as an external store -------------------------------------------
//
// Read via `useSyncExternalStore` so the three states below are one value React
// can render directly. The server snapshot is always "unknown": there is no
// sessionStorage during SSR, and guessing would flash the name prompt at people
// who already have an identity.

export type IdentityState =
  | { status: "unknown" }
  | { status: "absent" }
  | { status: "present"; user: CollabUser };

const UNKNOWN: IdentityState = { status: "unknown" };
const ABSENT: IdentityState = { status: "absent" };

// getSnapshot must return a stable reference or React re-renders forever, so
// the state is memoised here and only replaced on write.
let snapshot: IdentityState | null = null;
const listeners = new Set<() => void>();

export function subscribeIdentity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getIdentitySnapshot(): IdentityState {
  if (snapshot === null) {
    const stored = loadSessionUser();
    snapshot = stored ? { status: "present", user: stored } : ABSENT;
  }
  return snapshot;
}

export function getIdentityServerSnapshot(): IdentityState {
  return UNKNOWN;
}

/**
 * The single writer for identity. Refreshing the in-memory snapshot matters as
 * much as the storage write: landing -> room is a client-side navigation that
 * keeps this module alive, so a stale cache would re-prompt for a name.
 */
export function setActiveUser(user: CollabUser): void {
  saveSessionUser(user);
  saveNamePrefill(user.firstName, user.lastName);
  snapshot = { status: "present", user };
  listeners.forEach((listener) => listener());
}
