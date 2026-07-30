"use client";

// The database being unreachable is not the same thing as having no saved rooms,
// and the two must never render alike — the same `missing` vs `unreachable`
// distinction `RoomGate` draws for a room. Neon autosuspends an idle branch, so a
// cold start is a routine way to land here; "you have nothing saved" would be a
// lie the user has no way to check.
//
// `unstable_retry`, not `reset`. Next 16.2 added it and demoted `reset` to
// "clear the error state and re-render the children *without re-fetching*" —
// which is the wrong half for a failed query. Both props are passed; only this
// one re-runs the server render.

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
        {/* The digest is the only handle on a server-side error the browser gets;
            the message itself is redacted in production. */}
        {error.digest && (
          <p className="font-mono text-[11px] text-fg-subtle">Reference: {error.digest}</p>
        )}
      </ProfilePanel>
    </main>
  );
}
