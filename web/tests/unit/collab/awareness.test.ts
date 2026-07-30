import { describe, expect, it } from "vitest";
import type { Awareness } from "y-protocols/awareness";
import { readPeers, HEX_COLOR, FALLBACK_COLOR, FALLBACK_NAME } from "@/lib/collab/awareness";
import { CURSOR_COLORS } from "@/lib/collab/user";
import { HOSTILE_COLORS, VALID_COLORS, CSS_BREAKOUT, GRINNING, LONE_HIGH, NUL } from "../../fixtures/hostile";

// readPeers only ever calls getStates(), so a Map stub is a faithful double.
function awarenessOf(states: [number, unknown][]): Awareness {
  return { getStates: () => new Map(states) } as unknown as Awareness;
}

const user = (over: Record<string, unknown> = {}) => ({
  user: { name: "Ada Lovelace", color: CURSOR_COLORS[0], firstName: "Ada", lastName: "Lovelace", ...over },
});

describe("SEC-01 readPeers is the only boundary on peer awareness", () => {
  it("SEC-01a a colour that could break out of a CSS rule becomes grey", () => {
    for (const hostile of HOSTILE_COLORS) {
      const peers = readPeers(awarenessOf([[1, user({ color: hostile })]]), 1);
      expect(peers[0].color, `for ${JSON.stringify(hostile)}`).toBe(FALLBACK_COLOR);
    }
  });

  it("SEC-01b a genuine hex colour is preserved, in either case", () => {
    for (const good of VALID_COLORS) {
      expect(readPeers(awarenessOf([[1, user({ color: good })]]), 1)[0].color).toBe(good);
    }
  });

  it("SEC-01c HEX_COLOR is anchored, so no prefix or suffix sneaks through", () => {
    expect(HEX_COLOR.test("#ffffff")).toBe(true);
    expect(HEX_COLOR.test(`#ffffff${CSS_BREAKOUT}`)).toBe(false);
    expect(HEX_COLOR.test("x#ffffff")).toBe(false);
  });

  it("SEC-01d names are re-sanitized here too, not trusted from the wire", () => {
    const peers = readPeers(awarenessOf([[1, user({ name: `${NUL}Ada${LONE_HIGH}`, firstName: "", lastName: "" })]]), 1);
    expect(peers[0].name).toBe("Ada");
    const long = readPeers(awarenessOf([[1, user({ name: "a".repeat(200), firstName: "", lastName: "" })]]), 1);
    expect([...long[0].name].length).toBe(24);
  });

  it("SEC-01e a peer with no usable user object is skipped entirely", () => {
    const peers = readPeers(
      awarenessOf([
        [1, undefined],
        [2, {}],
        [3, { user: "x" }],
        [4, { user: 5 }],
        [5, { user: null }],
        [6, user()],
      ]),
      6
    );
    expect(peers.map((p) => p.clientID)).toEqual([6]);
  });

  it("SEC-01f an empty name becomes the fallback rather than a blank chip", () => {
    const peers = readPeers(awarenessOf([[1, { user: {} }]]), 1);
    expect(peers[0].name).toBe(FALLBACK_NAME);
    expect(peers[0].initials).toBe("?");
  });

  it("SEC-01g a real surrogate pair survives into the rendered name", () => {
    const peers = readPeers(awarenessOf([[1, user({ name: `Ada ${GRINNING}`, firstName: "", lastName: "" })]]), 1);
    expect(peers[0].name).toBe(`Ada ${GRINNING}`);
  });
});

describe("SEC-02 collision resolution is deterministic across viewers", () => {
  // Every viewer must independently compute the same winner, so resolution walks clientID
  // order rather than the local-first display order.
  const twoSameName: [number, unknown][] = [
    [7, { user: { name: "Naman S.", color: CURSOR_COLORS[0], firstName: "Naman", lastName: "Singla" } }],
    [3, { user: { name: "Naman S.", color: CURSOR_COLORS[1], firstName: "Naman", lastName: "Singla" } }],
  ];

  it("SEC-02a a shared name is numbered by ascending clientID, and the trailing dot goes", () => {
    const peers = readPeers(awarenessOf(twoSameName), 7);
    const byId = new Map(peers.map((p) => [p.clientID, p.name]));
    expect(byId.get(3)).toBe("Naman S1");
    expect(byId.get(7)).toBe("Naman S2");
  });

  it("SEC-02b insertion order cannot change the outcome", () => {
    const a = readPeers(awarenessOf(twoSameName), 7);
    const b = readPeers(awarenessOf([...twoSameName].reverse()), 7);
    const norm = (ps: typeof a) => ps.map((p) => `${p.clientID}:${p.name}:${p.color}`).sort();
    expect(norm(a)).toEqual(norm(b));
  });

  it("SEC-02c a duplicate colour is swapped for the first unclaimed palette entry", () => {
    const peers = readPeers(
      awarenessOf([
        [1, { user: { name: "A", color: CURSOR_COLORS[0] } }],
        [2, { user: { name: "B", color: CURSOR_COLORS[0] } }],
        [3, { user: { name: "C", color: CURSOR_COLORS[0] } }],
      ]),
      1
    );
    const colors = peers.sort((x, y) => x.clientID - y.clientID).map((p) => p.color);
    expect(colors[0]).toBe(CURSOR_COLORS[0]);
    expect(new Set(colors).size).toBe(3);
    expect(CURSOR_COLORS).toContain(colors[1]);
  });

  it("SEC-02d a second grey peer takes a palette colour, since grey is not in the palette", () => {
    const peers = readPeers(
      awarenessOf([
        [1, { user: { name: "A", color: "bogus" } }],
        [2, { user: { name: "B", color: "bogus" } }],
      ]),
      1
    );
    const byId = new Map(peers.map((p) => [p.clientID, p.color]));
    expect(byId.get(1)).toBe(FALLBACK_COLOR);
    expect(byId.get(2)).toBe(CURSOR_COLORS[0]);
  });

  it("SEC-02e an exhausted palette repeats rather than throwing", () => {
    const states: [number, unknown][] = Array.from({ length: 12 }, (_, i) => [
      i + 1,
      { user: { name: `P${i}`, color: CURSOR_COLORS[0] } },
    ]);
    const peers = readPeers(awarenessOf(states), 1);
    expect(peers).toHaveLength(12);
    for (const p of peers) expect(HEX_COLOR.test(p.color)).toBe(true);
  });

  it("SEC-02f display order puts the local peer first, then ascending clientID", () => {
    const peers = readPeers(
      awarenessOf([
        [9, { user: { name: "C", color: CURSOR_COLORS[2] } }],
        [4, { user: { name: "B", color: CURSOR_COLORS[1] } }],
        [7, { user: { name: "me", color: CURSOR_COLORS[0] } }],
      ]),
      7
    );
    expect(peers.map((p) => p.clientID)).toEqual([7, 4, 9]);
    expect(peers[0].isLocal).toBe(true);
  });
});
