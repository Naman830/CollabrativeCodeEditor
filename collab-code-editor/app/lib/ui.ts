// The shared class strings for buttons, cards, inputs and pills.
//
// This file exists because `primaryButton`/`secondaryButton` were previously
// declared twice, byte-for-byte, in `components/ProfileShell.tsx` and
// `components/RoomGate.tsx` — with a comment in the former admitting they were
// "the same values as RoomGate". Two copies of a colour is how a redesign ends
// up half-applied.
//
// Deliberately plain strings with no imports: `ProfileShell` is a server
// component and `RoomGate` is a client one, so anything shared between them has
// to be safe in both. Nothing here reads state, the DOM or the database.

/** Joins class names, dropping anything falsy. Lets callers write `cn(base, cond && extra)`. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Keyboard focus treatment. Every interactive element gets this — the ring is
 *  drawn in `--accent`, which differs per theme, so it stays visible on both. */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-app";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed";

/** The one call to action on a screen. */
export const primaryButton = cn(
  buttonBase,
  focusRing,
  "bg-accent px-4 py-2 text-accent-contrast hover:bg-accent-strong",
  "disabled:bg-raised disabled:text-fg-subtle",
);

/** Everything alongside a primary: Retry, Back, Save. */
export const secondaryButton = cn(
  buttonBase,
  focusRing,
  "border border-edge bg-raised px-4 py-2 text-fg hover:border-edge-strong hover:bg-edge",
  "disabled:border-edge disabled:bg-transparent disabled:text-fg-subtle",
);

/** Borderless until hovered — toolbar and nav affordances. */
export const ghostButton = cn(
  buttonBase,
  focusRing,
  "px-3 py-1.5 text-fg-muted hover:bg-raised hover:text-fg",
);

/** Run: the only green in the product, so it reads as "execute" and nothing else. */
export const runButton = cn(
  buttonBase,
  focusRing,
  "bg-success px-4 py-1.5 text-white hover:bg-success-strong",
  "disabled:bg-raised disabled:text-fg-subtle",
);

/** Small bordered chips: room id, sync status, counts. */
export const chip =
  "inline-flex items-center gap-1.5 rounded-lg border border-edge bg-raised/60 px-2.5 py-1.5 text-xs text-fg-muted";

/** The surface every dialog, panel and card sits on. */
export const card =
  "rounded-2xl border border-edge bg-panel shadow-xl shadow-[var(--shadow-color)]";

export const inputField = cn(
  focusRing,
  "w-full rounded-lg border border-edge bg-raised px-3 py-2.5 text-sm text-fg",
  "transition-colors placeholder:text-fg-subtle focus:border-accent",
);

/** Small uppercase section headings ("Output", "In this room"). */
export const sectionLabel =
  "text-[11px] font-medium uppercase tracking-wider text-fg-subtle";
