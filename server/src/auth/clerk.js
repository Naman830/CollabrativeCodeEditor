// The one place a Clerk token becomes a user ID; never awareness or any client-supplied field.

const { verifyToken } = require("@clerk/backend");

// Optional, like DATABASE_URL: unset means no members and no snapshots, which is v1's behaviour.
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

// Node's fetch has no default timeout, and the first verification fetches Clerk's JWKS.
const VERIFY_TIMEOUT_MS = 5_000;

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
      verifyToken(token, { secretKey: CLERK_SECRET_KEY }),
      new Promise((resolve) => unref(setTimeout(() => resolve(null), VERIFY_TIMEOUT_MS))),
    ]);
    return typeof payload?.sub === "string" ? payload.sub : null;
  } catch (err) {
    // Once per process: a wrong-instance key fails every token with no other visible symptom.
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        `Clerk token verification is failing (${err.reason ?? err.message}). ` +
          `Dead-room snapshots will record no members until this is fixed.`,
      );
    }
    return null;
  }
}

module.exports = { isEnabled, verifyClerkToken };
