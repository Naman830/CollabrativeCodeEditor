// A dependency-free, in-memory sliding-window rate limiter.
//
// In-memory is a v1 constraint, not an oversight: no database, no Redis. So the
// count is per serverless instance — a caller spread across N warm instances
// gets up to N times the limit. It bounds a flood; it is not a security
// boundary.
//
// `server/rateLimit.js` is the same algorithm for the sync server. The two
// workspaces share no code, so the duplication is intentional.

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the oldest hit in the window expires. 0 when allowed. */
  retryAfterSeconds: number;
};

type Options = {
  /** Requests allowed per window, per key. */
  limit: number;
  windowMs: number;
  /**
   * Ceiling on tracked keys — without it the map is the abuse vector, since one
   * request per forged IP grows it forever. Overflow drops the oldest entries,
   * which at worst forgives a limited caller.
   */
  maxKeys?: number;
};

export function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }: Options) {
  /** key -> ascending timestamps of hits still inside the window. */
  const hits = new Map<string, number[]>();

  return function check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Map iteration is insertion-ordered and every allowed hit re-inserts its
    // key at the end, so the head is the least recently active entry.
    if (hits.size > maxKeys) {
      for (const key of hits.keys()) {
        hits.delete(key);
        if (hits.size <= maxKeys) break;
      }
    }

    const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= limit) {
      // The window frees a slot when its oldest hit ages out.
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

/**
 * Best-effort caller identity. `x-forwarded-for` is only trustworthy because
 * Vercel overwrites it in production, so this bounds accidents and casual
 * scripts rather than a determined attacker.
 *
 * Anything unattributable shares one bucket, which fails closed: unidentified
 * callers throttle each other instead of going unlimited.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Left-most entry is the original client; the rest are proxy hops.
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
