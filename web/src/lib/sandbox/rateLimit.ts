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

// `x-forwarded-for` is trustworthy only because Vercel overwrites it; anything
// unattributable shares one bucket, which fails closed.
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
