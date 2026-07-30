// In-memory sliding window, counted per serverless instance: it bounds a flood,
// it is not a security boundary. Keep in sync with `server/src/http/rateLimit.js`.

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type Options = {
  limit: number;
  windowMs: number;
  /** Ceiling on tracked keys — without it the map itself is the abuse vector. */
  maxKeys?: number;
};

export function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }: Options) {
  const hits = new Map<string, number[]>();

  return function check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - windowMs;

    // INVARIANT: eviction relies on Map insertion order, so every allowed hit
    // must re-insert its key (delete then set) or the head stops being oldest.
    if (hits.size > maxKeys) {
      for (const key of hits.keys()) {
        hits.delete(key);
        if (hits.size <= maxKeys) break;
      }
    }

    const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] - cutoff) / 1000));
      hits.set(key, recent);
      return { allowed: false, retryAfterSeconds };
    }

    recent.push(now);
    hits.delete(key);
    hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

const TRUSTED_PROXY_HOPS = (() => {
  const parsed = Number(process.env.TRUSTED_PROXY_HOPS ?? "1");
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 8 ? parsed : 1;
})();

// Loose on purpose: this only has to reject junk that would otherwise become a limiter key.
const IP_LITERAL = /^[0-9a-f.:]{3,45}$/i;

function normalizeIp(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^\[|\]$/g, "");
  const bare = /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(trimmed)
    ? trimmed.slice(0, trimmed.indexOf(":"))
    : trimmed;
  return IP_LITERAL.test(bare) ? bare.toLowerCase() : null;
}

// INVARIANT: right-most minus (hops - 1) — correct whether the platform appends to
// x-forwarded-for or overwrites it; left-most is correct for neither, and it let a caller pick
// its own bucket. Anything unattributable shares one "unknown" bucket, which fails closed.
// Keep in sync with server/src/http/rateLimit.js.
export function clientKey(request: Request): string {
  if (TRUSTED_PROXY_HOPS > 0) {
    const chain = (request.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map(normalizeIp)
      .filter((value): value is string => value !== null);
    if (chain.length > 0) return chain[Math.max(0, chain.length - TRUSTED_PROXY_HOPS)];
  }
  return normalizeIp(request.headers.get("x-real-ip")) ?? "unknown";
}
