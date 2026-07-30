import { afterEach, describe, expect, it } from "vitest";
import { renderAwarenessStyles, removeAwarenessStyles } from "@/lib/collab/cursorStyles";
import type { Peer } from "@/lib/collab/awareness";
import { CSS_BREAKOUT, STYLE_CLOSE } from "../../fixtures/hostile";

const peer = (over: Partial<Peer> = {}): Peer => ({
  clientID: 1,
  name: "Ada L.",
  initials: "AL",
  color: "#ef9a9a",
  isLocal: false,
  ...over,
});

function sheet(): string {
  return document.querySelector("style#yjs-remote-cursor-styles")?.textContent ?? "";
}

afterEach(() => removeAwarenessStyles());

describe("SEC-03 the remote-cursor stylesheet escapes peer names", () => {
  it("SEC-03a a double quote cannot close the CSS string", () => {
    renderAwarenessStyles([peer({ name: 'Ada" x' })]);
    expect(sheet()).toContain('\\"');
    expect(sheet()).not.toMatch(/content: "Ada" x"/);
  });

  it("SEC-03b backslashes are escaped BEFORE quotes, or the escape escapes itself", () => {
    // Input a\b must become a\\b. If the order were reversed, an input of `\"` would emit
    // \\" and the string would close.
    renderAwarenessStyles([peer({ name: "a\\b" })]);
    expect(sheet()).toContain("a\\\\b");

    removeAwarenessStyles();
    renderAwarenessStyles([peer({ name: 'a\\"b' })]);
    const text = sheet();
    // Count quotes inside the content declaration: it must still be a single closed string.
    const decl = text.match(/content: "(.*)";/)?.[1] ?? "";
    expect(decl).toBe('a\\\\\\"b');
  });

  it("SEC-03c newlines become the CSS \\A escape, and CRLF collapses to one", () => {
    renderAwarenessStyles([peer({ name: "a\nb" })]);
    expect(sheet()).toContain("a\\A b");
    removeAwarenessStyles();
    renderAwarenessStyles([peer({ name: "a\r\nb" })]);
    expect((sheet().match(/\\A /g) ?? []).length).toBe(1);
  });

  it("SEC-03d textContent is used, so </style> cannot break out of the element", () => {
    renderAwarenessStyles([peer({ name: STYLE_CLOSE })]);
    const el = document.querySelector("style#yjs-remote-cursor-styles");
    // If innerHTML had been used, the browser would have ended the element early and this
    // would no longer be a single style node holding the text.
    expect(el?.childElementCount).toBe(0);
    expect(document.querySelectorAll("style").length).toBe(1);
  });

  it("SEC-03e the local peer gets no rule at all", () => {
    renderAwarenessStyles([peer({ isLocal: true })]);
    expect(sheet()).toBe("");
  });

  it("SEC-03f the sheet is regenerated whole, so a departed peer's rule disappears", () => {
    renderAwarenessStyles([peer({ clientID: 1 }), peer({ clientID: 2 })]);
    expect(sheet()).toContain("yRemoteSelection-2");
    renderAwarenessStyles([peer({ clientID: 1 })]);
    expect(sheet()).toContain("yRemoteSelection-1");
    expect(sheet()).not.toContain("yRemoteSelection-2");
  });

  it("SEC-03g repeated renders reuse one style element", () => {
    renderAwarenessStyles([peer()]);
    renderAwarenessStyles([peer()]);
    expect(document.querySelectorAll("style#yjs-remote-cursor-styles").length).toBe(1);
  });

  it("SEC-03h removeAwarenessStyles is idempotent", () => {
    renderAwarenessStyles([peer()]);
    removeAwarenessStyles();
    removeAwarenessStyles();
    expect(document.querySelector("style#yjs-remote-cursor-styles")).toBeNull();
  });

  // The contract test: this module does NOT validate colours, so readPeers must. Feeding it a
  // raw hostile colour demonstrates the injection that guard prevents — it is why the two
  // modules are coupled, and why nothing may call this with unfiltered awareness state.
  it("SEC-03i a raw non-hex colour DOES reach the stylesheet, proving readPeers is load-bearing", () => {
    renderAwarenessStyles([peer({ color: CSS_BREAKOUT })]);
    expect(sheet()).toContain("body { display: none }");
  });
});
