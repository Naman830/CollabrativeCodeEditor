// Reading *remote* awareness state. Every field here was set by a peer, on its
// own machine, and never passed through our identity form — so nothing in it can
// be trusted. This module is the single place that turns that raw state into
// values the UI is allowed to render.
//
// React escapes text nodes, so a hostile name is not an injection risk in the
// user bar the way it is in the cursor <style> tag. It is still clamped: an
// unbounded or control-character-laden name would wreck the layout, and the
// name shown next to a cursor must match the name shown in the bar.

import { sanitizeName, initials as initialsOf } from "./user";
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
 * The local user sorts first; everyone else sorts by clientID, which is stable
 * for the lifetime of a connection so the bar doesn't reshuffle on every
 * keystroke-driven awareness update.
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

  return peers.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return a.clientID - b.clientID;
  });
}
