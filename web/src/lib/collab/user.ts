// The live-room user model: the name a collaborator typed and the colour we
// assigned. Clerk (./clerkIdentity.ts) sits alongside it, never replacing it.

export type CollabUser = {
  firstName: string;
  lastName: string;
  color: string;
  // INVARIANT: client-only — never goes into the awareness payload, which is
  // peer-controlled, so a broadcast account ID would be a forgeable claim.
  clerkUserId?: string;
};

// Fixed palette so remote cursor colours stay legible in both themes.
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

// INVARIANT: keep in sync with `UNSTORABLE` in server/src/rooms/state.js — a NUL or
// unpaired surrogate in a name rejects the room's whole snapshot INSERT.
const UNSTORABLE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// A UX guard, not the trust boundary for remote names (that is `lib/collab/awareness.ts`).
// Cut by code point: a UTF-16 slice can halve a surrogate pair.
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
    // Must stay optional: no guest record has this field, and rejecting those
    // would log the whole world out on first load.
    (clerkUserId === undefined || typeof clerkUserId === "string")
  );
}

// INVARIANT: sessionStorage, not localStorage — each tab must be its own collaborator.
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

// Only the name is mirrored to localStorage; the colour re-rolls each session so
// two tabs stay visually distinct.
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

// Read via `useSyncExternalStore`. The server snapshot must stay "unknown": there is
// no sessionStorage during SSR, and guessing flashes the prompt at people who have one.

export type IdentityState =
  | { status: "unknown" }
  | { status: "absent" }
  | { status: "present"; user: CollabUser };

const UNKNOWN: IdentityState = { status: "unknown" };
const ABSENT: IdentityState = { status: "absent" };

// INVARIANT: getSnapshot must return a stable reference or React re-renders forever.
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

// The single writer. Refreshing the in-memory snapshot matters as much as the storage
// write: landing -> room keeps this module alive, so a stale cache re-prompts for a name.
export function setActiveUser(user: CollabUser): void {
  saveSessionUser(user);
  saveNamePrefill(user.firstName, user.lastName);
  snapshot = { status: "present", user };
  listeners.forEach((listener) => listener());
}
