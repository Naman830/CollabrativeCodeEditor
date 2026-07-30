// INVARIANT: nothing here may reach the database (no lib/data/deadRooms.ts) —
// error.tsx is a Client Component and imports ProfilePanel from this file.

import { SignInButton } from "@clerk/nextjs";
import SiteNav from "./SiteNav";
import { UserIcon } from "@/components/ui/icons";
import { card, primaryButton } from "@/lib/ui";

export function PanelIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-raised text-fg-muted">
      {children}
    </span>
  );
}

export function ProfilePanel({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`relative mx-auto flex max-w-sm flex-col items-center gap-4 p-8 text-center ${card}`}>
      <PanelIcon>{icon}</PanelIcon>
      {/* h1, not h2: this IS the page title, and an h2 with no h1 above it fails
          page-has-heading-one on /profile and on the 404, which reuses this panel. */}
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      {children}
    </div>
  );
}

type ProfileShellProps = {
  children: React.ReactNode;
  backHref: string;
  backLabel: string;
};

export default function ProfileShell({ children, backHref, backLabel }: ProfileShellProps) {
  return (
    <>
      <SiteNav backHref={backHref} backLabel={backLabel} />
      <main id="main-content" className="wash relative flex-1 px-4 py-10">
        <div className="relative mx-auto w-full max-w-3xl">{children}</div>
      </main>
    </>
  );
}

// An in-page gate, never redirect()/auth.protect(): there is no /sign-in route,
// so either would eject a shared /profile deep link.
export function ProfileSignInGate() {
  return (
    <ProfileShell backHref="/" backLabel="Home">
      <ProfilePanel icon={<UserIcon className="h-5 w-5" />} title="Sign in to see your rooms">
        <p className="text-sm text-fg-muted">
          Saved rooms belong to an account. Guests can create, join and run code exactly as
          before — nothing is stored for them, so there is nothing here to show.
        </p>
        <SignInButton mode="modal">
          <button type="button" className={primaryButton}>
            Sign in
          </button>
        </SignInButton>
      </ProfilePanel>
    </ProfileShell>
  );
}
