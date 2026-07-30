import { describe, expect, it } from "vitest";
import { MAX_CODE_BYTES, codeByteLength, payloadTooLarge } from "@/lib/sandbox/execution";
import { GRINNING } from "../../fixtures/hostile";

describe("EC-01 the combined code+stdin byte budget", () => {
  it("EC-01a byte length is UTF-8, not String.length", () => {
    expect(codeByteLength("abc")).toBe(3);
    expect(codeByteLength("é")).toBe(2);
    expect(codeByteLength("漢")).toBe(3);
    expect(codeByteLength(GRINNING)).toBe(4);
    expect(codeByteLength("")).toBe(0);
  });

  it("EC-01b the cap is 64 KB and inclusive at the boundary", () => {
    expect(MAX_CODE_BYTES).toBe(65_536);
    expect(payloadTooLarge("a".repeat(65_536), "")).toBeNull();
    expect(payloadTooLarge("a".repeat(65_537), "")).not.toBeNull();
  });

  it("EC-01c code and stdin share ONE budget - the documented boundary case", () => {
    // 60 KB + 3 KB runs; 60 KB + 8 KB does not. Straight from CLAUDE.md.
    expect(payloadTooLarge("a".repeat(60 * 1024), "b".repeat(3 * 1024))).toBeNull();
    expect(payloadTooLarge("a".repeat(60 * 1024), "b".repeat(8 * 1024))).not.toBeNull();
    // Exactly at the line, split across both fields.
    expect(payloadTooLarge("a".repeat(61_440), "b".repeat(4_096))).toBeNull();
    expect(payloadTooLarge("a".repeat(61_440), "b".repeat(4_097))).not.toBeNull();
  });

  it("EC-01d the message names stdin only when stdin is actually present", () => {
    const withoutStdin = payloadTooLarge("a".repeat(70_000), "");
    const withStdin = payloadTooLarge("a".repeat(70_000), "x");
    expect(withoutStdin).not.toBe(withStdin);
    expect(withStdin?.toLowerCase()).toContain("input");
  });

  it("EC-01e a document of emoji is capped by bytes, not characters", () => {
    // 16385 * 4 = 65540 bytes, but String.length is only 32770.
    const emoji = GRINNING.repeat(16_385);
    expect(emoji.length).toBeLessThan(MAX_CODE_BYTES);
    expect(payloadTooLarge(emoji, "")).not.toBeNull();
  });
});
