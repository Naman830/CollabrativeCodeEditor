// A dependency-free, in-memory sliding-window rate limiter.
//
// In-memory is a deliberate choice, not an oversight: v1 has no database and no
// Redis (see V1_Tasks.md's out-of-scope list), and a shared counter store is the
// only thing that would make this exact across processes. The consequence is
// worth stating plainly — on Vercel each serverless instance keeps its own
// counters, so a caller spread across N warm instances gets up to N times the
// nominal limit. That still turns an unbounded flood into a bounded one, which
// is what this is for; it is not a security boundary.
//
// `server/rateLimit.js` is the same algorithm for the sync server. The two
// workspaces share no code (no root package.json), so the duplication is
// intentional, exactly like `CLOSE_ROOM_NOT_FOUND`.

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
   * Ceiling on tracked keys. Without it the map is itself the abuse vector: one
   * request per forged IP would grow it without bound. On overflow the oldest
   * entries are dropped, which at worst forgives a limited caller.
   */
  maxKeys?: number;
};

export function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }: Options) {
  /** key -> ascending timestamps of hits still inside the window. */
  const hits = new Map<string, number[]>();

  return function check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Map iteration order is insertion order, and every allowed hit re-inserts
    // its key at the end (delete + set below), so the head is the least recently
    // active entry — dropping from there evicts stale keys first.
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
 * Best-effort caller identity. `x-forwarded-for` is trustworthy only because a
 * proxy that overwrites it (Vercel) sits in front in production; a directly
 * exposed deployment could be fed a forged header, so this bounds accidents and
 * casual scripts rather than a determined attacker.
 *
 * Everything unattributable collapses to one shared bucket, which fails closed:
 * unidentified callers throttle each other rather than going unlimited.
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
