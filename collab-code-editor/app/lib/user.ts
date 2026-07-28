// Client-side identity for a collaborator: a name they typed and a colour we
// assigned. Deliberately never leaves the browser — there is no account system
// and no server-side persistence, so this module is the whole user model.

export type CollabUser = {
  firstName: string;
  lastName: string;
  color: string;
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
 * Names end up interpolated into a CSS `content:` string for remote cursor
 * labels, so keep them to a single line of printable text. This is a UX guard,
 * not the security boundary — remote awareness state never passes through here,
 * so the escaping at render time is what actually has to hold.
 */
export function sanitizeName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/** "Naman Gupta" -> "Naman G." — short enough to sit above a caret. */
export function displayName(user: CollabUser): string {
  const initial = user.lastName.charAt(0).toUpperCase();
  return initial ? `${user.firstName} ${initial}.` : user.firstName;
}

/**
 * "Naman Gupta" -> "NG" — for the user bar's avatar chips. Takes just the name
 * parts, not a whole CollabUser, because the bar also builds chips for remote
 * peers, who have no colour we're willing to trust at this point.
 */
export function initials(user: { firstName: string; lastName: string }): string {
  return (
    user.firstName.charAt(0) + user.lastName.charAt(0)
  ).toUpperCase();
}

function isValidUser(value: unknown): value is CollabUser {
  if (typeof value !== "object" || value === null) return false;
  const { firstName, lastName, color } = value as Record<string, unknown>;
  return (
    typeof firstName === "string" &&
    typeof lastName === "string" &&
    typeof color === "string" &&
    sanitizeName(firstName).length > 0 &&
    sanitizeName(lastName).length > 0 &&
    CURSOR_COLORS.includes(color)
  );
}

/**
 * The active identity lives in sessionStorage rather than localStorage on
 * purpose: each tab gets its own user, so opening a second tab on the same room
 * produces a genuinely separate collaborator instead of a duplicate of you.
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
    };
  } catch {
    // Malformed JSON, or storage disabled entirely (Safari private mode
    // throws on access). Either way, treat it as "no identity yet".
    return null;
  }
}

function saveSessionUser(user: CollabUser): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch {
    // Non-fatal: the identity still lives in React state for this page's
    // lifetime, we just cannot restore it after a refresh.
  }
}

/**
 * Only the name is mirrored to localStorage, and only to prefill the form on a
 * return visit. The colour is deliberately excluded — re-rolling it per session
 * is what keeps two tabs visually distinguishable.
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
// Exposed through `useSyncExternalStore` rather than useState + useEffect so the
// three states below are a single value React can render directly. "unknown" is
// what the server snapshot returns: during SSR and the hydration pass there is
// no sessionStorage to consult, and rendering the name prompt in that window
// would flash it at users who already have an identity.

export type IdentityState =
  | { status: "unknown" }
  | { status: "absent" }
  | { status: "present"; user: CollabUser };

const UNKNOWN: IdentityState = { status: "unknown" };
const ABSENT: IdentityState = { status: "absent" };

// getSnapshot must be referentially stable between calls or React re-renders
// forever, so the computed state is memoised here and only replaced on write.
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
 * The single writer for identity. Updating the in-memory snapshot matters as
 * much as the storage write: navigating from the landing page to a room is a
 * client-side transition that keeps this module alive, so a stale cache would
 * make the room re-prompt someone who just filled the form in.
 */
export function setActiveUser(user: CollabUser): void {
  saveSessionUser(user);
  saveNamePrefill(user.firstName, user.lastName);
  snapshot = { status: "present", user };
  listeners.forEach((listener) => listener());
}
