// A dependency-free, in-memory sliding-window rate limiter.
//
// In-memory is the only option v1 allows: no database, no Redis (V1_Tasks.md's
// out-of-scope list). That is exact here in a way it is not on the frontend —
// this server is a single Railway process, so one counter really does see every
// request — but it resets on restart and would not survive being scaled out.
//
// `collab-code-editor/app/lib/rateLimit.ts` is the same algorithm for the Next
// routes. The two workspaces share no code (there is no root package.json), so
// the duplication is intentional, exactly like CLOSE_ROOM_NOT_FOUND.
//
// This is distinct from MAX_RESERVATIONS in rooms.js: that is a global ceiling
// on how many unclaimed rooms may exist at once, with no notion of who created
// them. This bounds a single caller.

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

    // Without a ceiling the map is itself the abuse vector: one request per
    // forged source address would grow it without bound. Map iteration is
    // insertion-ordered and every allowed hit re-inserts its key at the tail,
    // so the head is the least recently active entry.
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
 * so `x-forwarded-for` is what carries the real client address — `remoteAddress`
 * alone would put every request behind the proxy into one bucket. The header is
 * forgeable by anyone talking to the server directly, so this bounds accidents
 * and casual scripts, not a determined attacker.
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
