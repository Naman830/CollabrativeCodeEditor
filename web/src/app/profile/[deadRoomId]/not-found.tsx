// INVARIANT: one answer for "no such snapshot" and "not yours" — no existence oracle.
// INVARIANT: no `loading.tsx` under `app/profile/` — a streamed response serves this under a 200.

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
