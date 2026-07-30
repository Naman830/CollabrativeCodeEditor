"use client";

// INVARIANT: `unstable_retry`, not `reset` — only it re-runs a failed server render.

import Link from "next/link";
import { ProfilePanel } from "@/components/layout/ProfileShell";
import SiteNav from "@/components/layout/SiteNav";
import { AlertIcon } from "@/components/ui/icons";
import { primaryButton, secondaryButton } from "@/lib/ui";

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
      <main id="main-content" className="wash relative flex flex-1 items-center justify-center px-4 py-16">
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
          {error.digest && (
            <p className="font-mono text-[11px] text-fg-subtle">Reference: {error.digest}</p>
          )}
        </ProfilePanel>
      </main>
    </>
  );
}
