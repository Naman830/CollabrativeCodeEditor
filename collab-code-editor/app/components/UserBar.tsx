"use client";

import type { Peer } from "../lib/awareness";

// Chips shown before the rest collapse into a "+N". The bar sits above the
// editor and must not wrap onto a second line on a laptop.
const MAX_VISIBLE = 6;

type UserBarProps = {
  peers: Peer[];
  /** False until the provider has opened a socket; nothing to show yet. */
  connected: boolean;
};

/**
 * Presence for the room: one chip per client, in that peer's cursor colour so
 * the chip and the caret read as the same person.
 *
 * Everything here comes from `readPeers`, which sanitizes untrusted awareness
 * state. Never read `awareness.getStates()` from a component.
 */
export default function UserBar({ peers, connected }: UserBarProps) {
  const visible = peers.slice(0, MAX_VISIBLE);
  const overflow = peers.slice(MAX_VISIBLE);

  return (
    <div className="flex items-center gap-3 border-b border-edge bg-panel px-4 py-2">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        In this room
      </span>

      {peers.length === 0 ? (
        <span className="text-xs text-zinc-500">
          {connected ? "No one else here yet" : "Joining…"}
        </span>
      ) : (
        <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
          {visible.map((peer) => (
            <li
              key={peer.clientID}
              title={peer.isLocal ? `${peer.name} (you)` : peer.name}
              className={`flex items-center gap-2 rounded-full border py-0.5 pl-0.5 pr-3 transition-colors ${
                peer.isLocal
                  ? "border-zinc-600 bg-raised"
                  : "border-edge bg-raised/60"
              }`}
            >
              <span
                aria-hidden
                className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold text-[#141414] ring-2 ring-panel"
                style={{ backgroundColor: peer.color }}
              >
                {peer.initials}
              </span>
              <span className="max-w-[10rem] truncate text-xs text-zinc-200">
                {peer.name}
                {peer.isLocal && <span className="text-zinc-500"> (you)</span>}
              </span>
            </li>
          ))}

          {overflow.length > 0 && (
            <li
              title={overflow.map((peer) => peer.name).join(", ")}
              className="rounded-full border border-edge bg-raised/60 px-2.5 py-1 text-xs text-zinc-400"
            >
              +{overflow.length}
            </li>
          )}
        </ul>
      )}

      <span className="ml-auto shrink-0 rounded-full border border-edge bg-raised/60 px-2.5 py-1 text-[11px] text-zinc-400">
        {peers.length} {peers.length === 1 ? "person" : "people"}
      </span>
    </div>
  );
}
