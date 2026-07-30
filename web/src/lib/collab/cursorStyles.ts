// The remote-cursor `<style>` block: one caret colour and one name label per
// peer, injected into <head> because Monaco owns the DOM the carets live in and
// there is no React element to hang a style prop on.
//
// It consumes `readPeers`'s output (see `lib/collab/awareness.ts`) and must never read
// `awareness.getStates()` itself — a colour straight off the wire reaching a CSS
// rule is the injection this indirection exists to stop.

import type { Peer } from "./awareness";

const AWARENESS_STYLE_ID = "yjs-remote-cursor-styles";

// Escape order matters: backslashes first, or we re-escape our own escapes.
// Newlines are illegal in a CSS string and become the \A escape.
function cssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\A ");
}

/**
 * Rebuilds the remote-cursor <style> tag from the same deduped peers the user
 * bar renders, so a caret label always matches that person's chip. Regenerating
 * the whole block drops rules for clients who have left.
 */
export function renderAwarenessStyles(peers: Peer[]): void {
  let styleEl = document.getElementById(AWARENESS_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = AWARENESS_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  const rules: string[] = [];
  peers.forEach(({ clientID, name, color, isLocal }) => {
    if (isLocal) return;

    rules.push(`
      .yRemoteSelection-${clientID} {
        background-color: ${color}55;
      }
      .yRemoteSelectionHead-${clientID} {
        position: relative;
        border-left: 2px solid ${color};
      }
      .yRemoteSelectionHead-${clientID}::after {
        content: "${cssString(name)}";
        position: absolute;
        top: -1.1em;
        left: -2px;
        white-space: nowrap;
        font-size: 11px;
        font-family: sans-serif;
        padding: 1px 4px;
        border-radius: 2px;
        color: #1e1e1e;
        background-color: ${color};
        pointer-events: none;
        z-index: 10;
      }
    `);
  });

  styleEl.textContent = rules.join("\n");
}

/** Teardown counterpart: the rules belong to the connection that just died. */
export function removeAwarenessStyles(): void {
  document.getElementById(AWARENESS_STYLE_ID)?.remove();
}
