"use client";

import { useEffect, useRef, useState, type SubmitEventHandler } from "react";
import {
  CURSOR_COLORS,
  loadNamePrefill,
  randomColor,
  sanitizeName,
  type CollabUser,
} from "@/lib/collab/user";
import { cn, focusRing, primaryButton } from "@/lib/ui";

type IdentityDialogProps = {
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: (user: CollabUser) => void;
  /** Omitted when there is nowhere to back out to (the in-room prompt). */
  onCancel?: () => void;
  /** Submitting is a network round trip; a second click would reserve a second room. */
  busy?: boolean;
  /**
   * Set when the person is signed in with Clerk. The dialog still opens — a
   * Clerk session is one cookie shared by every tab, while a `CollabUser` is
   * per-tab sessionStorage, and skipping the prompt would quietly collapse two
   * tabs into one collaborator (see CLAUDE.md, "Identity storage is split on
   * purpose"). So the account fills the fields in and rolls a fresh colour;
   * it does not replace the step.
   */
  clerkUserId?: string;
  clerkPrefill?: { firstName: string; lastName: string } | null;
  signedInAs?: string;
};

/**
 * Name + colour prompt, shared by the create and join flows.
 *
 * Keep it out of the server-rendered tree — the initializers below read
 * browser-only storage, so the first render must happen in the browser. For the
 * same reason callers must not mount this until Clerk has resolved: the
 * initializers run once, so a `clerkPrefill` arriving later is never read.
 */
export default function IdentityDialog({
  title,
  description,
  submitLabel,
  onSubmit,
  onCancel,
  busy = false,
  clerkUserId,
  clerkPrefill,
  signedInAs,
}: IdentityDialogProps) {
  const [prefill] = useState(loadNamePrefill);
  // Clerk's profile beats the localStorage prefill — it's the name the person
  // actually registered — but only per-field, so a Clerk account with a first
  // name and no last name still falls back rather than blanking the field.
  const [firstName, setFirstName] = useState(
    () => clerkPrefill?.firstName || prefill?.firstName || ""
  );
  const [lastName, setLastName] = useState(
    () => clerkPrefill?.lastName || prefill?.lastName || ""
  );
  const [color, setColor] = useState(() => randomColor());
  const firstNameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    firstNameRef.current?.focus();
  }, []);

  // Escape closes (when there is anywhere to close *to*), and Tab is trapped.
  //
  // The trap is not decoration: this is `aria-modal="true"`, which promises
  // assistive tech that the rest of the page is inert — but nothing enforces
  // that for a keyboard user, so without it Tab walks straight out of the dialog
  // and into a page that is visually behind a scrim. The in-room prompt is the
  // worst case: it has no cancel button, so escaping it by Tab strands you on a
  // room you cannot interact with.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onCancel) {
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has already escaped.
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const cleanFirst = sanitizeName(firstName);
  const cleanLast = sanitizeName(lastName);
  const isValid = cleanFirst.length > 0 && cleanLast.length > 0;
  const preview =
    (cleanFirst.charAt(0) + cleanLast.charAt(0)).toUpperCase() || "?";

  const handleSubmit: SubmitEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    if (!isValid || busy) return;
    // `clerkUserId` rides inside the identity record, so it reaches
    // sessionStorage through `setActiveUser` — the single writer — rather than
    // needing a second storage path of its own.
    onSubmit({ firstName: cleanFirst, lastName: cleanLast, color, clerkUserId });
  };

  const fieldClass =
    "w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-fg transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 dark:bg-black/70 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="identity-dialog-title"
        className="w-full max-w-sm rounded-2xl border border-edge bg-panel p-6 text-fg shadow-2xl shadow-[var(--shadow-color)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2
              id="identity-dialog-title"
              className="text-lg font-semibold text-fg"
            >
              {title}
            </h2>
            <p className="text-sm text-fg-muted">{description}</p>
            {signedInAs && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                />
                <span className="truncate">Signed in as {signedInAs}</span>
              </p>
            )}
          </div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="-mr-1 -mt-1 rounded-lg px-2 py-1 text-lg leading-none text-fg-muted transition-colors hover:bg-raised hover:text-fg"
            >
              &times;
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          {/* Stacks below `sm`: two side-by-side inputs on a 360px screen left
              about 140px each, which is not enough to see a name you typed. */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-fg-muted">First name</span>
              <input
                ref={firstNameRef}
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                maxLength={24}
                autoComplete="given-name"
                className={fieldClass}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-fg-muted">Last name</span>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                maxLength={24}
                autoComplete="family-name"
                className={fieldClass}
              />
            </label>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-edge bg-raised/60 p-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                // #141414 rather than a token: this is dark text on the chosen
                // pastel, and CURSOR_COLORS are mid-tones that carry dark text
                // in either theme. It must not follow the theme.
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold text-[#141414]"
                style={{ backgroundColor: color }}
              >
                {preview}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm text-fg">Your cursor colour</span>
                <span className="text-xs text-fg-muted">
                  Others see this next to your caret.
                </span>
              </span>
            </div>

            {/* The whole palette, not just a Shuffle button. `readPeers` already
                re-assigns a colour that collides with an earlier peer's, so this
                is a preference rather than a guarantee — but picking beats
                re-rolling until you get the one you wanted. */}
            <div role="radiogroup" aria-label="Cursor colour" className="flex flex-wrap gap-1.5">
              {CURSOR_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  role="radio"
                  aria-checked={swatch === color}
                  aria-label={`Colour ${swatch}`}
                  onClick={() => setColor(swatch)}
                  className={cn(
                    "h-6 w-6 rounded-full transition-transform",
                    focusRing,
                    swatch === color
                      ? "ring-2 ring-fg ring-offset-2 ring-offset-raised"
                      : "hover:scale-110",
                  )}
                  style={{ backgroundColor: swatch }}
                />
              ))}
              <button
                type="button"
                onClick={() => setColor(randomColor())}
                className={cn(
                  "ml-auto rounded-lg border border-edge px-2.5 py-1 text-xs font-medium",
                  "text-fg-muted transition-colors hover:bg-edge hover:text-fg",
                  focusRing,
                )}
              >
                Shuffle
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={!isValid || busy}
            className={cn(primaryButton, "py-2.5")}
          >
            {busy && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {submitLabel}
          </button>

          {/* An earlier version of this comment said dead-room snapshots did not
              exist yet and so the dialog must promise nothing about saving. 7.3
              shipped and that is no longer true — but the promise still has to
              be hedged, because a snapshot needs a signed-in participant who
              stayed 60s *and* edited (see CLAUDE.md, "Who a dead room belongs
              to"). "can be saved" is the strongest honest form. */}
          <p className="text-center text-xs text-fg-muted">
            {!isValid
              ? "Enter both a first and last name to continue."
              : signedInAs
                ? "Your name and colour are per-tab; your account isn't."
                : "No account needed — this stays in your browser."}
          </p>
        </form>
      </div>
    </div>
  );
}
