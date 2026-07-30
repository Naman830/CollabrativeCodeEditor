"use client";

import { useEffect } from "react";

export type ActivityToast = {
  id: string;
  kind: "join" | "leave";
  name: string;
  color: string;
};

const AUTO_DISMISS_MS = 4000;

type ToastRowProps = {
  toast: ActivityToast;
  onDismiss: (id: string) => void;
};

function ToastRow({ toast, onDismiss }: ToastRowProps) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <li className="animate-toast-in pointer-events-auto flex items-center gap-2.5 rounded-xl border border-edge bg-panel/95 py-2 pl-2.5 pr-3.5 text-xs text-fg shadow-xl shadow-[var(--shadow-color)] backdrop-blur">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-panel"
        style={{ backgroundColor: toast.color }}
      />
      <span>
        <span className="font-medium text-fg">{toast.name}</span>{" "}
        <span className="text-fg-muted">
          {toast.kind === "join" ? "joined the room" : "left the room"}
        </span>
      </span>
    </li>
  );
}

type ActivityToastsProps = {
  toasts: ActivityToast[];
  onDismiss: (id: string) => void;
};

/** Names and colours arrive already sanitized, built from `readPeers`'s output. */
export default function ActivityToasts({ toasts, onDismiss }: ActivityToastsProps) {
  if (toasts.length === 0) return null;

  return (
    // `env(safe-area-inset-bottom)`: a plain `bottom-4` hides these under iOS chrome.
    <ul
      className="pointer-events-none fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4"
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}
