// Reached from `notFound()` in this segment's page, for two different causes
// that deliberately produce one answer: the id names no snapshot, or it names
// one this account holds no `dead_room_members` row for. Distinguishing them
// would turn the URL into an oracle for which ids exist.
//
// There is no `loading.tsx` anywhere under `app/profile/`, and that is what makes
// this a real 404. A Suspense boundary in the parent segment would also wrap this
// route; once a response starts streaming its status is already sent, and Next
// then serves the not-found UI under a 200.

import Link from "next/link";
import ProfileShell, { ProfilePanel } from "@/components/layout/ProfileShell";
import { primaryButton } from "@/lib/ui";

export default function SnapshotNotFound() {
  return (
    <ProfileShell backHref="/profile" backLabel="Your rooms">
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
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        }
        title="No such saved room"
      >
        <p className="text-sm text-fg-muted">
          This snapshot either doesn&apos;t exist or isn&apos;t on your profile. A room is
          only saved for the people who were signed in, stayed a while, and edited it.
        </p>
        <Link href="/profile" className={primaryButton}>
          Back to your rooms
        </Link>
      </ProfilePanel>
    </ProfileShell>
  );
}
