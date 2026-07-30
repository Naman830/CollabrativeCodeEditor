"use client";

// "Database unreachable" must never render like "you have no saved rooms".
// INVARIANT: retry via `unstable_retry`, not `reset` — `reset` re-renders without re-fetching.

import { ProfilePanel } from "@/components/layout/ProfileShell";
import { primaryButton } from "@/lib/ui";

export default function ProfileError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <main className="relative flex flex-1 items-center justify-center px-4 py-10">
      <ProfilePanel
        icon={
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <path d="M5 12.5a7 7 0 0 1 14 0" />
            <path d="M8.5 15.5a3.5 3.5 0 0 1 7 0" />
            <path d="M12 19h.01" />
            <path d="m4 4 16 16" />
          </svg>
        }
        title="Couldn't load your rooms"
      >
        <p className="text-sm text-fg-muted">
          Your saved rooms are still there — we just couldn&apos;t reach the database. Try
          again in a moment.
        </p>
        <button type="button" onClick={() => unstable_retry()} className={primaryButton}>
          Try again
        </button>
        {error.digest && (
          <p className="font-mono text-[11px] text-fg-subtle">Reference: {error.digest}</p>
        )}
      </ProfilePanel>
    </main>
  );
}
