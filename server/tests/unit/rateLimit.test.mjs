import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createRateLimiter, clientKey } = require(join(import.meta.dirname, "../../src/http/rateLimit.js"));

// A minimal Node request double: clientKey only reads headers and socket.remoteAddress.
const req = (headers = {}, remoteAddress = "203.0.113.1") => ({ headers, socket: { remoteAddress } });

describe("SEC-10 the sync server's rate-limit key cannot be chosen by the caller", () => {
  it("SEC-10a a forged left-most hop no longer picks the bucket", () => {
    const a = clientKey(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.7" }));
    const b = clientKey(req({ "x-forwarded-for": "9.9.9.9, 198.51.100.7" }));
    expect(a).toBe("198.51.100.7");
    expect(b).toBe(a);
  });

  it("SEC-10b rotating a forged prefix cannot escape one bucket", () => {
    const check = createRateLimiter({ limit: 10, windowMs: 60_000 });
    const verdicts = Array.from({ length: 11 }, (_, i) =>
      check(clientKey(req({ "x-forwarded-for": `10.0.0.${i}, 198.51.100.7` })))
    );
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(10);
    expect(verdicts[10].allowed).toBe(false);
  });

  it("SEC-10c an array-valued header (Node can produce one) is handled, not ignored", () => {
    expect(clientKey(req({ "x-forwarded-for": ["1.1.1.1", "198.51.100.7"] }))).toBe("198.51.100.7");
  });

  it("SEC-10d junk never becomes a key; it falls back to the socket address", () => {
    expect(clientKey(req({ "x-forwarded-for": "not-an-ip" }))).toBe("203.0.113.1");
    expect(clientKey(req({ "x-forwarded-for": "," }))).toBe("203.0.113.1");
    expect(clientKey(req({ "x-forwarded-for": "" }))).toBe("203.0.113.1");
    expect(clientKey(req({ "x-forwarded-for": "junk, 198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("SEC-10e ports are stripped so one client is not many keys", () => {
    expect(clientKey(req({ "x-forwarded-for": "198.51.100.7:52001" }))).toBe("198.51.100.7");
  });

  it("SEC-10f IPv6 is normalised, brackets and case included", () => {
    expect(clientKey(req({ "x-forwarded-for": "[2001:DB8::5]" }))).toBe("2001:db8::5");
  });

  it("SEC-10g with no header and no socket address, everything shares one bucket", () => {
    expect(clientKey({ headers: {}, socket: {} })).toBe("unknown");
  });

  it("SEC-10h TRUSTED_PROXY_HOPS=0 ignores the header entirely", async () => {
    process.env.TRUSTED_PROXY_HOPS = "0";
    const path = require.resolve(join(import.meta.dirname, "../../src/http/rateLimit.js"));
    delete require.cache[path];
    const fresh = require(path);
    expect(fresh.clientKey(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.7" }))).toBe("203.0.113.1");
    delete process.env.TRUSTED_PROXY_HOPS;
    delete require.cache[path];
  });
});

describe("API-10 the sliding window, identical in shape to the web copy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("API-10a allows exactly `limit`, then refuses with a retry hint", () => {
    const check = createRateLimiter({ limit: 3, windowMs: 1_000 });
    expect([check("k"), check("k"), check("k")].every((v) => v.allowed)).toBe(true);
    expect(check("k")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    vi.advanceTimersByTime(1_001);
    expect(check("k").allowed).toBe(true);
  });

  it("API-10b retryAfterSeconds counts to the oldest hit ageing out", () => {
    const check = createRateLimiter({ limit: 1, windowMs: 60_000 });
    check("k");
    vi.advanceTimersByTime(30_000);
    expect(check("k").retryAfterSeconds).toBe(30);
  });

  it("API-10c a denied hit is not recorded, so it cannot extend the penalty", () => {
    const check = createRateLimiter({ limit: 1, windowMs: 1_000 });
    check("k");
    vi.advanceTimersByTime(600);
    check("k");
    vi.advanceTimersByTime(401);
    expect(check("k").allowed).toBe(true);
  });

  it("API-10d eviction skips a key an allowed hit moved to the tail", () => {
    const check = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 3 });
    check("a");
    check("b");
    check("c");
    check("a"); // allowed -> re-inserted at the tail
    check("d");
    check("e"); // evicts the head, which must be `b`
    expect(check("a").allowed).toBe(false); // kept its two hits
    expect(check("b").allowed).toBe(true); // was evicted, starts fresh
  });
});
