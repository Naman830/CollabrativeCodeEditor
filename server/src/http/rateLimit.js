// In-memory sliding-window rate limiter; keep in sync with web/src/lib/sandbox/rateLimit.ts.
// One process, one counter, and since the key is no longer caller-chosen, POST /rooms is a real
// per-address bound. (The web copy stays approximate for a different reason: per-instance state.)

const { intFromEnv } = require("../env");

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

// INVARIANT: x-forwarded-for is only trustworthy from the *right*. A proxy that appends puts
// the address it observed last; everything left of that is caller-supplied. Reading the
// left-most value let one script mint a fresh limiter bucket — and a fresh snapshot pacing
// key — per request. Keep in sync with web/src/lib/sandbox/rateLimit.ts.
const TRUSTED_PROXY_HOPS = intFromEnv(process.env.TRUSTED_PROXY_HOPS, 1, {
  min: 0,
  max: 8,
  name: "TRUSTED_PROXY_HOPS",
});

// Loose on purpose: this only has to reject junk that would otherwise become a limiter key.
const IP_LITERAL = /^[0-9a-f.:]{3,45}$/i;

function normalizeIp(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim().replace(/^\[|\]$/g, "");
  // "1.2.3.4:5678" would otherwise be a distinct key per connection.
  const bare = /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(trimmed)
    ? trimmed.slice(0, trimmed.indexOf(":"))
    : trimmed;
  return IP_LITERAL.test(bare) ? bare.toLowerCase() : null;
}

function clientKey(req) {
  const direct = normalizeIp(req.socket?.remoteAddress) ?? "unknown";
  if (TRUSTED_PROXY_HOPS === 0) return direct;

  const header = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map(normalizeIp)
    .filter(Boolean);
  if (chain.length === 0) return direct;

  // Right-most minus (hops - 1): the address the closest trusted proxy observed. Correct
  // whether the platform appends to the header or overwrites it; left-most is correct for
  // neither. An over-count clamps to the left-most, i.e. degrades to the old behaviour.
  return chain[Math.max(0, chain.length - TRUSTED_PROXY_HOPS)];
}

module.exports = { createRateLimiter, clientKey };
