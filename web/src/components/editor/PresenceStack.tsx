"use client";

// Presence, as an overlapping avatar stack in the chrome bar.
//
// This replaces the full-width `UserBar` row, which spent a whole line of
// vertical space on one chip per person. The information is the same — who is
// here, in their cursor colour, with the local user marked — but it now costs
// about 90px of a row it shares with everything else.
//
// Everything rendered here comes from `readPeers` (see `lib/collab/awareness.ts`),
// which sanitizes untrusted awareness state. Never read `awareness.getStates()`
// from a component: a colour straight off the wire reaching an inline `style`
// is the injection that indirection exists to stop.

import type { Peer } from "@/lib/collab/awareness";

/** Avatars shown before the rest collapse into a "+N". */
const MAX_VISIBLE = 4;

type PresenceStackProps = {
  peers: Peer[];
  /** False until the provider has opened a socket; nothing to show yet. */
  connected: boolean;
};

export default function PresenceStack({ peers, connected }: PresenceStackProps) {
  if (peers.length === 0) {
    return (
      <span className="text-xs text-fg-subtle">{connected ? "Just you" : "Joining…"}</span>
    );
  }

  const visible = peers.slice(0, MAX_VISIBLE);
  const overflow = peers.slice(MAX_VISIBLE);

  return (
    <div className="flex items-center gap-2">
      <ul
        className="flex items-center -space-x-2"
        aria-label={`${peers.length} ${peers.length === 1 ? "person" : "people"} in this room`}
      >
        {visible.map((peer) => (
          <li
            key={peer.clientID}
            title={peer.isLocal ? `${peer.name} (you)` : peer.name}
            // The ring is drawn in the panel colour so the avatars read as
            // stacked cards rather than merging into one blob.
            className="relative rounded-full ring-2 ring-panel transition-transform hover:z-10 hover:-translate-y-0.5"
          >
            <span
              aria-hidden
              // #141414 rather than a token: this is dark text on the peer's own
              // pastel avatar, and CURSOR_COLORS are mid-tones that carry dark
              // text in either theme. It must not follow the theme.
              className="grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold text-[#141414]"
              style={{ backgroundColor: peer.color }}
            >
              {peer.initials}
            </span>
            <span className="sr-only">
              {peer.name}
              {peer.isLocal && " (you)"}
            </span>
          </li>
        ))}

        {overflow.length > 0 && (
          <li
            title={overflow.map((peer) => peer.name).join(", ")}
            className="relative grid h-7 w-7 place-items-center rounded-full bg-raised text-[10px] font-semibold text-fg-muted ring-2 ring-panel"
          >
            +{overflow.length}
          </li>
        )}
      </ul>
    </div>
  );
}
