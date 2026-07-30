import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientKey, createRateLimiter } from "@/lib/sandbox/rateLimit";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/execute", { method: "POST", headers });
}

describe("SEC-07 clientKey cannot be chosen by the caller", () => {
  // The whole point: with one trusted hop, the right-most entry is the address the proxy
  // observed, and everything left of it is attacker-supplied.
  it("SEC-07a a forged left-most hop no longer picks the bucket", () => {
    const a = clientKey(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }));
    const b = clientKey(req({ "x-forwarded-for": "2.2.2.2, 203.0.113.7" }));
    const c = clientKey(req({ "x-forwarded-for": "9.9.9.9, 203.0.113.7" }));
    expect(a).toBe("203.0.113.7");
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it("SEC-07b rotating a forged prefix cannot escape a single limiter bucket", () => {
    const check = createRateLimiter({ limit: 10, windowMs: 60_000 });
    const verdicts = Array.from({ length: 11 }, (_, i) =>
      check(clientKey(req({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` })))
    );
    expect(verdicts.slice(0, 10).every((v) => v.allowed)).toBe(true);
    // Before the fix all eleven were allowed, each in its own forged bucket.
    expect(verdicts[10].allowed).toBe(false);
    expect(verdicts[10].retryAfterSeconds).toBeGreaterThan(0);
  });

  it("SEC-07c a single-entry chain is used as-is", () => {
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("SEC-07d junk that is not an IP literal never becomes a key", () => {
    expect(clientKey(req({ "x-forwarded-for": "not-an-ip" }))).toBe("unknown");
    expect(clientKey(req({ "x-forwarded-for": "<script>" }))).toBe("unknown");
    expect(clientKey(req({ "x-forwarded-for": "," }))).toBe("unknown");
    expect(clientKey(req({ "x-forwarded-for": "" }))).toBe("unknown");
    // A junk left-most beside a real right-most still resolves to the real one.
    expect(clientKey(req({ "x-forwarded-for": "junk, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("SEC-07e a port is stripped so one client is not many keys", () => {
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.7:44321" }))).toBe("203.0.113.7");
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.7:1, 203.0.113.7:2" }))).toBe("203.0.113.7");
  });

  it("SEC-07f IPv6 is normalised, brackets and case included", () => {
    expect(clientKey(req({ "x-forwarded-for": "[2001:DB8::1]" }))).toBe("2001:db8::1");
    expect(clientKey(req({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("SEC-07g x-real-ip is the fallback, and everything else shares one bucket", () => {
    expect(clientKey(req({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientKey(req({ "x-real-ip": "junk" }))).toBe("unknown");
    expect(clientKey(req({}))).toBe("unknown");
  });
});

describe("API-09 the sliding window", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("API-09a allows exactly `limit` per window, then refuses", () => {
    const check = createRateLimiter({ limit: 3, windowMs: 1_000 });
    expect([check("k"), check("k"), check("k")].every((v) => v.allowed)).toBe(true);
    const denied = check("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(1);

    vi.advanceTimersByTime(1_001);
    expect(check("k").allowed).toBe(true);
  });

  it("API-09b retryAfterSeconds counts to the oldest hit ageing out", () => {
    const check = createRateLimiter({ limit: 1, windowMs: 60_000 });
    check("k");
    vi.advanceTimersByTime(30_000);
    expect(check("k").retryAfterSeconds).toBe(30);
  });

  it("API-09c a sub-second wait still reports at least 1", () => {
    const check = createRateLimiter({ limit: 1, windowMs: 100 });
    check("k");
    expect(check("k").retryAfterSeconds).toBe(1);
  });

  it("API-09d keys are independent", () => {
    const check = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(check("a").allowed).toBe(true);
    expect(check("b").allowed).toBe(true);
    expect(check("a").allowed).toBe(false);
  });

  it("API-09e a denied hit does not extend the penalty window", () => {
    const check = createRateLimiter({ limit: 1, windowMs: 1_000 });
    check("k");
    vi.advanceTimersByTime(600);
    check("k"); // denied, and must not be recorded
    vi.advanceTimersByTime(401);
    expect(check("k").allowed).toBe(true);
  });

  // This is the assertion that catches someone collapsing `delete`+`set` into a plain `set`:
  // eviction walks Map insertion order, so an *allowed* hit must move its key to the tail or
  // the head stops being the stalest. `maxKeys: 3` matters — with a tighter cap every call
  // evicts and the test would pass either way.
  it("API-09f an allowed hit moves its key to the tail, so eviction skips it", () => {
    const check = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 3 });
    check("a"); // a:1                       order: a
    check("b"); //                           order: a b
    check("c"); //                           order: a b c
    check("a"); // a:2, re-inserted          order: b c a
    check("d"); // size 4                    order: b c a d
    check("e"); // evicts head `b`           order: c a d e

    // `a` kept its two hits through an eviction it would have been the victim of had the
    // re-insertion not happened — without it the order would still be a,b,c,d and `a` would
    // have been dropped, coming back allowed with a fresh window.
    expect(check("a").allowed).toBe(false);
    // `b` was the stalest and is gone, so it starts over.
    expect(check("b").allowed).toBe(true);
  });
});
