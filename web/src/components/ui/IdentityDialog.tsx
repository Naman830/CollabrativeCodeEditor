"use client";

import { useEffect, useId, useRef, useState, type SubmitEventHandler } from "react";
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
  onCancel?: () => void;
  busy?: boolean;
  // INVARIANT: Clerk only prefills; it never replaces this prompt, or two tabs
  // collapse into one collaborator (CLAUDE.md, "Identity storage is split").
  clerkUserId?: string;
  clerkPrefill?: { firstName: string; lastName: string } | null;
  signedInAs?: string;
};

// INVARIANT: never server-rendered — the initializers below read browser storage
// once, so a late `clerkPrefill` is only picked up by a `key` remount.
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
  // Clerk beats the stored prefill per-field: a null last name must fall back,
  // not blank the field.
  // One id per instance: the hint is referenced by both inputs via aria-describedby.
  const dialogId = useId();
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

  // INVARIANT: `aria-modal="true"` promises the page is inert — this Tab trap is
  // what enforces it, and the in-room prompt has no cancel button to escape by.
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
    // `clerkUserId` rides in the record so `setActiveUser` stays the one writer.
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
                id={`${dialogId}-first`}
                aria-invalid={!isValid}
                aria-describedby={`${dialogId}-hint`}
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
                id={`${dialogId}-last`}
                aria-invalid={!isValid}
                aria-describedby={`${dialogId}-hint`}
                className={fieldClass}
              />
            </label>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-edge bg-raised/60 p-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                // #141414 not a token: dark text on the peer's pastel, and it
                // must not follow the theme.
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

            {/* A preference only: `readPeers` re-assigns a colliding colour. */}
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

          {/* INVARIANT: this <p> is what both inputs' aria-describedby points at, and it is a
              live region — the submit button is natively `disabled`, so it leaves the tab order
              entirely and a keyboard user otherwise gets no explanation for why nothing happens. */}
          <p
            id={`${dialogId}-hint`}
            role="status"
            aria-live="polite"
            className="text-center text-xs text-fg-muted"
          >
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
