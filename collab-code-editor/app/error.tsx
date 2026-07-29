"use client";

// The root error boundary: an unhandled throw anywhere outside `/profile`, which
// has its own (`profile/error.tsx`) because "the database is unreachable" is a
// specific, expected failure that deserves its own wording.
//
// `unstable_retry`, not `reset`. Next 16.2 added it and demoted `reset` to
// "clear the error state and re-render the children *without re-fetching*",
// which is the wrong half whenever the failure was a server render. Both props
// are passed; only this one re-runs it.

import Link from "next/link";
import { ProfilePanel } from "./components/ProfileShell";
import SiteNav from "./components/SiteNav";
import { AlertIcon } from "./components/icons";
import { primaryButton, secondaryButton } from "./lib/ui";

export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <>
      <SiteNav />
      <main className="wash relative flex flex-1 items-center justify-center px-4 py-16">
        <ProfilePanel icon={<AlertIcon className="h-5 w-5" />} title="Something went wrong">
          <p className="text-sm text-fg-muted">
            This page failed to load. Nothing you were working on in a room is affected by
            this — rooms live on the sync server, not here.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button type="button" onClick={() => unstable_retry()} className={primaryButton}>
              Try again
            </button>
            <Link href="/" className={secondaryButton}>
              Back to home
            </Link>
          </div>
          {/* The digest is the only handle on a server-side error the browser
              gets; the message itself is redacted in production. */}
          {error.digest && (
            <p className="font-mono text-[11px] text-fg-subtle">Reference: {error.digest}</p>
          )}
        </ProfilePanel>
      </main>
    </>
  );
}
