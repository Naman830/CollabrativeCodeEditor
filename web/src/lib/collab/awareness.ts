// INVARIANT: remote awareness state is peer-supplied; this module is the only place
// that turns it into values the UI may render.

import { CURSOR_COLORS, sanitizeName, initials as initialsOf } from "./user";
import type { Awareness } from "y-protocols/awareness";

// INVARIANT: colours land inside a CSS rule, so plain hex only — otherwise a peer can
// close the block and restyle every other participant's page.
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const FALLBACK_COLOR = "#9e9e9e";

const FALLBACK_NAME = "Anonymous";

export type Peer = {
  clientID: number;
  name: string;
  initials: string;
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

function deriveInitials(firstName: string, lastName: string, name: string): string {
  const fromParts = initialsOf({ firstName, lastName });
  if (fromParts) return fromParts;

  const words = name.split(" ").filter(Boolean);
  const derived = (words[0]?.charAt(0) ?? "") + (words[1]?.charAt(0) ?? "");
  return derived.toUpperCase() || "?";
}

// Duplicate names and colours are resolved here, walking by clientID — the one order
// every client agrees on, so all viewers pick the same winner. Display order comes after.
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
