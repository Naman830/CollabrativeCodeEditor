// Remote awareness state is untrusted: every field was set by a peer on its own
// machine and never passed through our form. This module is the one place that
// turns it into values the UI may render.

import { CURSOR_COLORS, sanitizeName, initials as initialsOf } from "./user";
import type { Awareness } from "y-protocols/awareness";

/**
 * Colours end up inside a CSS rule, where `red } body { display: none } .x {`
 * would escape the block and restyle the page. Plain hex only.
 */
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Shown for a peer whose colour failed the check above. */
const FALLBACK_COLOR = "#9e9e9e";

/** Shown for a peer whose name is empty or entirely unprintable. */
const FALLBACK_NAME = "Anonymous";

export type Peer = {
  clientID: number;
  /** Sanitized display name, safe to render as text. */
  name: string;
  /** One or two characters for the avatar chip. */
  initials: string;
  /** Guaranteed to match {@link HEX_COLOR}. */
  color: string;
  isLocal: boolean;
};

type RawUser = {
  name?: unknown;
  color?: unknown;
  firstName?: unknown;
  lastName?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? sanitizeName(value) : "";
}

/** Prefer the peer's name parts; fall back to the label's first letters. */
function deriveInitials(firstName: string, lastName: string, name: string): string {
  const fromParts = initialsOf({ firstName, lastName });
  if (fromParts) return fromParts;

  const words = name.split(" ").filter(Boolean);
  const derived = (words[0]?.charAt(0) ?? "") + (words[1]?.charAt(0) ?? "");
  return derived.toUpperCase() || "?";
}

/**
 * Snapshot every client present, local one included. Peers that haven't
 * published a `user` field yet are skipped and appear a tick later.
 *
 * Two peers can pick the same short name or colour by chance, and the identity
 * dialog can't see the room to prevent it, so both are resolved here once
 * awareness makes the clash visible: a shared name gets a number appended
 * ("Naman S." -> "Naman S1"), a taken colour swaps to the next free one.
 * Resolution walks peers by clientID — the one order every client agrees on —
 * so all viewers pick the same winner. Local-first display order comes after.
 */
export function readPeers(awareness: Awareness, localClientID: number): Peer[] {
  const peers: Peer[] = [];

  awareness.getStates().forEach((state, clientID) => {
    const user = (state as { user?: RawUser } | undefined)?.user;
    if (!user || typeof user !== "object") return;

    const firstName = asString(user.firstName);
    const lastName = asString(user.lastName);
    const name = asString(user.name) || [firstName, lastName].filter(Boolean).join(" ");

    peers.push({
      clientID,
      name: name || FALLBACK_NAME,
      initials: deriveInitials(firstName, lastName, name),
      color:
        typeof user.color === "string" && HEX_COLOR.test(user.color)
          ? user.color
          : FALLBACK_COLOR,
      isLocal: clientID === localClientID,
    });
  });

  peers.sort((a, b) => a.clientID - b.clientID);

  const nameCounts = new Map<string, number>();
  peers.forEach((peer) => nameCounts.set(peer.name, (nameCounts.get(peer.name) ?? 0) + 1));
  const nameSeen = new Map<string, number>();
  peers.forEach((peer) => {
    if ((nameCounts.get(peer.name) ?? 0) < 2) return;
    const n = (nameSeen.get(peer.name) ?? 0) + 1;
    nameSeen.set(peer.name, n);
    peer.name = `${peer.name.replace(/\.$/, "")}${n}`;
  });

  const claimedColors = new Set<string>();
  peers.forEach((peer) => {
    if (!claimedColors.has(peer.color)) {
      claimedColors.add(peer.color);
      return;
    }
    const free = CURSOR_COLORS.find((color) => !claimedColors.has(color));
    if (!free) return; // palette exhausted; a repeat is unavoidable here
    peer.color = free;
    claimedColors.add(free);
  });

  return peers.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return a.clientID - b.clientID;
  });
}
