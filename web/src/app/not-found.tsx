// INVARIANT: never add a `loading.tsx` — streaming locks the status at 200 and
// turns every real 404 into a soft one.

import type { Metadata } from "next";
import Link from "next/link";
import { ProfilePanel } from "@/components/layout/ProfileShell";
import SiteNav from "@/components/layout/SiteNav";
import { SearchIcon } from "@/components/ui/icons";
import { primaryButton, secondaryButton } from "@/lib/ui";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <>
      <SiteNav />
      <main className="wash relative flex flex-1 items-center justify-center px-4 py-16">
        <ProfilePanel icon={<SearchIcon className="h-5 w-5" />} title="Page not found">
          <p className="text-sm text-fg-muted">
            That address doesn&apos;t match anything here. If you were following a room link,
            the room may have closed — rooms live only while someone is in them.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/" className={primaryButton}>
              Back to home
            </Link>
            <Link href="/profile" className={secondaryButton}>
              Your rooms
            </Link>
          </div>
        </ProfilePanel>
      </main>
    </>
  );
}
