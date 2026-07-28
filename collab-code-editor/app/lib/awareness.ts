// Reading *remote* awareness state. Every field here was set by a peer, on its
// own machine, and never passed through our identity form — so nothing in it can
// be trusted. This module is the single place that turns that raw state into
// values the UI is allowed to render.
//
// React escapes text nodes, so a hostile name is not an injection risk in the
// user bar the way it is in the cursor <style> tag. It is still clamped: an
// unbounded or control-character-laden name would wreck the layout, and the
// name shown next to a cursor must match the name shown in the bar.

import { CURSOR_COLORS, sanitizeName, initials as initialsOf } from "./user";
import type { Awareness } from "y-protocols/awareness";

/**
 * Colours reach both an inline `style` and a CSS rule body, where a value like
 * `red } body { display: none } .x {` escapes the block and restyles the page.
 * Only a plain hex colour is ever let through.
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

/**
 * Prefer the structured name parts the peer publishes alongside its cursor
 * label; fall back to the first letters of the label itself when a peer only
 * sends `name` (an older client, or one that isn't ours at all).
 */
function deriveInitials(firstName: string, lastName: string, name: string): string {
  const fromParts = initialsOf({ firstName, lastName });
  if (fromParts) return fromParts;

  const words = name.split(" ").filter(Boolean);
  const derived = (words[0]?.charAt(0) ?? "") + (words[1]?.charAt(0) ?? "");
  return derived.toUpperCase() || "?";
}

/**
 * Snapshot every client currently present, including the local one. Peers that
 * have connected but not yet published a `user` field are skipped rather than
 * rendered blank — they show up a tick later once their state arrives.
 *
 * Two peers can independently end up with the same short name (two "Naman
 * Singla"s both render as "Naman S.") or the same color (an 8-color palette
 * picked at random, with no coordination between joiners). Neither is
 * preventable at pick time — the identity dialog has no visibility into the
 * room — so both are resolved here, reactively, once awareness makes the
 * collision visible:
 *  - a name shared by 2+ peers gets a 1-based number appended ("Naman S." ->
 *    "Naman S1" / "Naman S2")
 *  - a color already claimed by an earlier peer gets swapped for the first
 *    unclaimed color in the fixed palette
 * Resolution order is ascending clientID, not local-first — clientID is the
 * one ordering every client agrees on, so all viewers compute the same
 * winner. The local-first order used for display is applied afterward.
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
