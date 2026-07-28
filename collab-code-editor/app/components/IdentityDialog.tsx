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
  /**
   * Omitted when there is nowhere to back out to (the in-room prompt), which is
   * what decides whether a close button and Escape handler are wired up.
   */
  onCancel?: () => void;
};

/**
 * Callers must keep this component out of the server-rendered tree — mount it
 * behind a click (the landing page) or behind a resolved client-only identity
 * check (the room). Both lazy initializers below read browser-only state, which
 * is only safe because the first render always happens in the browser.
 */
export default function IdentityDialog({
  title,
  description,
  submitLabel,
  onSubmit,
  onCancel,
}: IdentityDialogProps) {
  const [prefill] = useState(loadNamePrefill);
  const [firstName, setFirstName] = useState(() => prefill?.firstName ?? "");
  const [lastName, setLastName] = useState(() => prefill?.lastName ?? "");
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

  const handleSubmit: SubmitEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    if (!isValid) return;
    onSubmit({ firstName: cleanFirst, lastName: cleanLast, color });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="identity-dialog-title"
        className="w-full max-w-sm rounded border border-zinc-700 bg-[#252526] p-6 text-zinc-200 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="identity-dialog-title" className="text-lg font-semibold">
              {title}
            </h2>
            <p className="text-sm text-zinc-400">{description}</p>
          </div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="-mr-1 -mt-1 rounded px-2 py-1 text-lg leading-none text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              &times;
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
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
                className="w-full rounded border border-zinc-700 bg-[#3c3c3c] px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                className="w-full rounded border border-zinc-700 bg-[#3c3c3c] px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <span
                aria-hidden="true"
                className="h-3.5 w-3.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              Your cursor color
            </div>
            <button
              type="button"
              onClick={() => setColor(randomColor())}
              className="rounded border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Shuffle
            </button>
          </div>

          <button
            type="submit"
            disabled={!isValid}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-900 disabled:text-zinc-400"
          >
            {submitLabel}
          </button>

          <p className="text-center text-xs text-zinc-500">
            {isValid
              ? "No account needed — this stays in your browser."
              : "Enter both a first and last name to continue."}
          </p>
        </form>
      </div>
    </div>
  );
}
