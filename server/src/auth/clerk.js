// The one place a Clerk token becomes a user ID; never awareness or any client-supplied field.

const { verifyToken } = require("@clerk/backend");

// Optional, like DATABASE_URL: unset means no members and no snapshots, which is v1's behaviour.
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

// Node's fetch has no default timeout, and the first verification fetches Clerk's JWKS.
const VERIFY_TIMEOUT_MS = 5_000;

// Optional, like CLERK_SECRET_KEY. Comma-separated app origins.
// INVARIANT: unset means the `azp` claim is unchecked, on purpose. @clerk/backend fails a token
// whose azp is *absent* just as hard as one that mismatches, so a wrong value here fails every
// token with the same invisible symptom as a wrong secret: rooms work, snapshots never appear.
// Vercel preview deployments have per-deployment hostnames and must leave this unset.
const AUTHORIZED_PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// INVARIANT: timers must never keep the process alive (same rule as rooms/lifecycle.js).
function unref(timer) {
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

let warnedOnce = false;

function isEnabled() {
  return Boolean(CLERK_SECRET_KEY);
}

// INVARIANT: never throws and never rejects — null for guest, expired, malformed, misconfigured,
// timed out. Callers must stay joinable regardless, and the token must never be logged.
async function verifyClerkToken(token) {
  if (!CLERK_SECRET_KEY || !token) return null;

  try {
    const payload = await Promise.race([
      verifyToken(token, {
        secretKey: CLERK_SECRET_KEY,
        ...(AUTHORIZED_PARTIES.length > 0 ? { authorizedParties: AUTHORIZED_PARTIES } : {}),
      }),
      new Promise((resolve) => unref(setTimeout(() => resolve(null), VERIFY_TIMEOUT_MS))),
    ]);
    return typeof payload?.sub === "string" ? payload.sub : null;
  } catch (err) {
    // Once per process: a wrong-instance key fails every token with no other visible symptom.
    if (!warnedOnce) {
      warnedOnce = true;
      // An azp rejection needs the message as well as the reason — the reason alone
      // ("token-invalid-authorized-parties") does not say which origin was refused. The azp is
      // an origin, not a secret; the token itself is still never logged.
      const detail =
        err.reason === "token-invalid-authorized-parties"
          ? `${err.reason}: ${err.message}`
          : (err.reason ?? err.message);
      console.warn(
        `Clerk token verification is failing (${detail}). ` +
          `Dead-room snapshots will record no members until this is fixed.`,
      );
    }
    return null;
  }
}

module.exports = { isEnabled, verifyClerkToken };
