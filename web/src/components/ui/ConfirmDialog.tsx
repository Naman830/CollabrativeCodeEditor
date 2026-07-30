"use client";

// INVARIANT: `aria-modal="true"` promises the page is inert — the Tab trap below
// is what enforces it. The label id is `useId()`, so two dialogs cannot collide.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn, card, secondaryButton } from "@/lib/ui";

type ConfirmDialogProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmClassName: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({
  title,
  children,
  confirmLabel,
  confirmClassName,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus lands on Cancel, not Confirm: a stray Enter must be the safe choice.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape is ignored mid-flight: the request is gone, so hide no result.
      if (e.key === "Escape") {
        if (!busy) onCancel();
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
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm dark:bg-black/70">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(card, "w-full max-w-sm p-6 text-fg")}
      >
        <h2 id={titleId} className="text-base font-semibold text-fg">
          {title}
        </h2>

        <div className="mt-2 text-sm text-fg-muted">{children}</div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={cn(secondaryButton, "px-3 py-1.5 text-xs")}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(confirmClassName, "px-3 py-1.5 text-xs")}
          >
            {busy && (
              <span
                aria-hidden
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
              />
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
