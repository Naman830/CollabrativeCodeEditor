// In-memory sliding-window rate limiter; keep in sync with web/src/lib/sandbox/rateLimit.ts.

function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  return function check(key) {
    const now = Date.now();
    const cutoff = now - windowMs;

    // INVARIANT: the map needs a ceiling or forged keys grow it forever. Iteration is
    // insertion-ordered and every allowed hit re-inserts its key, so the head is stalest.
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

// Railway terminates TLS ahead of this process, so `x-forwarded-for` holds the client address.
// INVARIANT: that header is forgeable — this bounds scripts, not attackers.
function clientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}

module.exports = { createRateLimiter, clientKey };
