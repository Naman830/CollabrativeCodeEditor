"use client";

import { useEffect, useRef, useState, type SubmitEventHandler } from "react";
import {
  loadNamePrefill,
  randomColor,
  sanitizeName,
  type CollabUser,
} from "../lib/user";

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

  useEffect(() => {
    firstNameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!onCancel) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
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
    "w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-zinc-100 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="identity-dialog-title"
        className="w-full max-w-sm rounded-2xl border border-edge bg-panel p-6 text-zinc-200 shadow-2xl shadow-black/50"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2
              id="identity-dialog-title"
              className="text-lg font-semibold text-zinc-50"
            >
              {title}
            </h2>
            <p className="text-sm text-zinc-400">{description}</p>
            {signedInAs && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
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
              className="-mr-1 -mt-1 rounded-lg px-2 py-1 text-lg leading-none text-zinc-500 transition-colors hover:bg-raised hover:text-zinc-200"
            >
              &times;
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-400">First name</span>
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
              <span className="text-xs font-medium text-zinc-400">Last name</span>
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

          <div className="flex items-center justify-between rounded-xl border border-edge bg-raised/60 p-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="grid h-9 w-9 place-items-center rounded-full text-xs font-bold text-[#141414]"
                style={{ backgroundColor: color }}
              >
                {preview}
              </span>
              <span className="flex flex-col">
                <span className="text-sm text-zinc-200">Your cursor colour</span>
                <span className="text-xs text-zinc-500">
                  Others see this next to your caret.
                </span>
              </span>
            </div>
            <button
              type="button"
              onClick={() => setColor(randomColor())}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-[#2c2c2c] hover:text-zinc-100"
            >
              Shuffle
            </button>
          </div>

          <button
            type="submit"
            disabled={!isValid || busy}
            className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-accent/20 transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-raised disabled:text-zinc-500 disabled:shadow-none"
          >
            {busy && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {submitLabel}
          </button>

          {/* Deliberately says nothing about saving. Dead-room snapshots are
              task 7.3 and do not exist yet, so promising a signed-in user that
              this room lands in their profile would be a lie. */}
          <p className="text-center text-xs text-zinc-500">
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
