// INVARIANT: plain strings, no imports — shared by server and client components,
// so nothing here may read state, the DOM or the database.

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-app";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed";

export const primaryButton = cn(
  buttonBase,
  focusRing,
  "bg-accent px-4 py-2 text-accent-contrast hover:bg-accent-strong",
  "disabled:bg-raised disabled:text-fg-subtle",
);

export const secondaryButton = cn(
  buttonBase,
  focusRing,
  "border border-edge bg-raised px-4 py-2 text-fg hover:border-edge-strong hover:bg-edge",
  "disabled:border-edge disabled:bg-transparent disabled:text-fg-subtle",
);

export const ghostButton = cn(
  buttonBase,
  focusRing,
  "px-3 py-1.5 text-fg-muted hover:bg-raised hover:text-fg",
);

/** The product's only red: irreversible actions, so keep it off routine controls. */
export const dangerButton = cn(
  buttonBase,
  focusRing,
  "bg-danger px-4 py-2 text-white hover:brightness-110",
  "disabled:bg-raised disabled:text-fg-subtle disabled:brightness-100",
);

export const runButton = cn(
  buttonBase,
  focusRing,
  "bg-success px-4 py-1.5 text-success-contrast hover:bg-success-strong",
  "disabled:bg-raised disabled:text-fg-subtle",
);

export const chip =
  "inline-flex items-center gap-1.5 rounded-lg border border-edge bg-raised/60 px-2.5 py-1.5 text-xs text-fg-muted";

export const card =
  "rounded-2xl border border-edge bg-panel shadow-xl shadow-[var(--shadow-color)]";

export const inputField = cn(
  focusRing,
  "w-full rounded-lg border border-edge bg-raised px-3 py-2.5 text-sm text-fg",
  "transition-colors placeholder:text-fg-subtle focus:border-accent",
);

export const sectionLabel =
  "text-[11px] font-medium uppercase tracking-wider text-fg-subtle";
