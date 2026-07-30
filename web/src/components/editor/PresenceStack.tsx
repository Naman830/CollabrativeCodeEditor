"use client";

// INVARIANT: render only `readPeers()` output (`lib/collab/awareness.ts`) — never raw
// `awareness.getStates()`, whose colours reach an inline `style`.

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
            className="relative rounded-full ring-2 ring-panel transition-transform hover:z-10 hover:-translate-y-0.5"
          >
            <span
              aria-hidden
              // #141414 not a token: dark text on the peer's own pastel, so it must not follow the theme.
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
