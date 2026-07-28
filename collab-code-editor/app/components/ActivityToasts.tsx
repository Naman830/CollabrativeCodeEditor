"use client";

import { useEffect } from "react";

export type ActivityToast = {
  id: string;
  kind: "join" | "leave";
  name: string;
  color: string;
};

// Long enough to read, short enough that a busy room's toasts don't stack up
// forever.
const AUTO_DISMISS_MS = 4000;

type ToastRowProps = {
  toast: ActivityToast;
  onDismiss: (id: string) => void;
};

function ToastRow({ toast, onDismiss }: ToastRowProps) {
  // Each row owns its own timer, keyed on the toast's id, so toasts dismiss
  // independently of one another regardless of arrival order.
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <li className="pointer-events-auto flex items-center gap-2 rounded-md border border-zinc-700 bg-[#2d2d2d] px-3 py-2 text-xs text-zinc-200 shadow-lg">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: toast.color }}
      />
      <span>
        <span className="font-medium">{toast.name}</span>{" "}
        {toast.kind === "join" ? "joined the room" : "left the room"}
      </span>
    </li>
  );
}

type ActivityToastsProps = {
  toasts: ActivityToast[];
  onDismiss: (id: string) => void;
};

/**
 * Subtle join/leave banners, stacked bottom-right. `toasts` is built from
 * `readPeers`'s output in `CodeEditor.tsx` (never raw awareness state), so
 * names/colors here are already sanitized the same way the user bar's are.
 */
export default function ActivityToasts({ toasts, onDismiss }: ActivityToastsProps) {
  if (toasts.length === 0) return null;

  return (
    <ul className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}
