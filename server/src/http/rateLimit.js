// A dependency-free, in-memory sliding-window rate limiter.
//
// In-memory is a v1 constraint: no database, no Redis. It is exact here, unlike
// on the frontend — one Railway process means one counter sees every request —
// but it resets on restart and would not survive scaling out.
//
// `collab-code-editor/app/lib/rateLimit.ts` is the same algorithm for the Next
// routes. The two workspaces share no code, so the duplication is intentional.
//
// Different from MAX_RESERVATIONS in rooms.js: that caps how many unclaimed
// rooms may exist at all; this bounds a single caller.

/**
 * @param {{limit: number, windowMs: number, maxKeys?: number}} options
 * @returns {(key: string) => {allowed: boolean, retryAfterSeconds: number}}
 */
function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  /** @type {Map<string, number[]>} key -> ascending hit timestamps inside the window */
  const hits = new Map();

  return function check(key) {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Without a ceiling the map is the abuse vector: one request per forged
    // address grows it forever. Map iteration is insertion-ordered and every
    // allowed hit re-inserts its key at the tail, so the head is the stalest.
    if (hits.size > maxKeys) {
      for (const stale of hits.keys()) {
        hits.delete(stale);
        if (hits.size <= maxKeys) break;
      }
    }

    const recent = (hits.get(key) || []).filter((at) => at > cutoff);

    if (recent.length >= limit) {
      // A slot frees up when the window's oldest hit ages out.
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
 * Best-effort caller identity. Railway terminates TLS in front of this process,
 * so `x-forwarded-for` carries the real client address — `remoteAddress` alone
 * would put every request into one bucket. The header is forgeable by anyone
 * talking to the server directly, so this bounds scripts, not attackers.
 */
function clientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    // Left-most entry is the original client; the rest are proxy hops.
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}

module.exports = { createRateLimiter, clientKey };
