// The root 404: any URL that matches no route at all.
//
// Distinct from `profile/[deadRoomId]/not-found.tsx`, which answers a *specific*
// question ("that snapshot isn't yours, or never existed") and keeps the profile
// back-link. This one knows nothing about the visitor and offers the two things
// that always work: go home, or create a room.
//
// Note there is deliberately no `loading.tsx` anywhere in this app. A Suspense
// boundary starts streaming, which sends the HTTP headers, which locks the
// status at 200 — turning every real 404 into a soft one. See Next's own
// `loading.md`, "Status Codes".

import type { Metadata } from "next";
import Link from "next/link";
import { ProfilePanel } from "./components/ProfileShell";
import SiteNav from "./components/SiteNav";
import { SearchIcon } from "./components/icons";
import { primaryButton, secondaryButton } from "./lib/ui";

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
