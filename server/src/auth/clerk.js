// The one place a Clerk token becomes a user ID.
//
// Task 7.3 needs to know who was signed in while a room was alive, and tasks.md
// §6.1 is emphatic about where that may come from: a token the *server* checked,
// never awareness and never any client-supplied field. Awareness is
// peer-controlled (see collab-code-editor/app/lib/awareness.ts), so an account ID
// broadcast there is a claim anyone can forge — and a forged one would write a
// room's code into a stranger's profile. That is why `clerkUserId` is
// deliberately absent from the awareness payload in `useCollabRoom.ts`, and why
// this file exists instead.
//
// Two rules govern everything below:
//
//   1. Verification NEVER refuses a socket. A bad, expired or missing token just
//      means no membership is recorded. Clerk being slow, misconfigured or down
//      must never be able to make a room unjoinable — CLAUDE.md already documents
//      that exact failure ("The dialog must never wait on Clerk"), where gating
//      the name prompt on Clerk left a deep-linked room with no way in at all.
//   2. The token is never logged. It arrives in a query string, so it is the one
//      secret this process handles; see the `req.url` logging ban in CLAUDE.md.

const { verifyToken } = require("@clerk/backend");

// Optional, exactly like DATABASE_URL in db.js. Unset, no token is ever verified,
// no room ever has members, and no snapshot is ever written — which is precisely
// v1's behaviour. The guest flow stores nothing, so it must not depend on auth
// infrastructure it never touches.
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

// Node's fetch has no default timeout, and the first verification of the process
// fetches Clerk's JWKS over the network. Without this a hung fetch would leave a
// pending promise holding a reference to the socket for as long as the process
// lives.
const VERIFY_TIMEOUT_MS = 5_000;

/** Timers must never be the reason the process stays alive (same rule as rooms.js). */
function unref(timer) {
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

let warnedOnce = false;

/** True when a CLERK_SECRET_KEY was configured. */
function isEnabled() {
  return Boolean(CLERK_SECRET_KEY);
}

/**
 * Verifies a Clerk session token and returns its subject (the Clerk user ID),
 * or null for anything else — guest, expired, malformed, misconfigured, timed
 * out. Never throws, and never rejects.
 *
 * @param {string | null | undefined} token
 * @returns {Promise<string | null>}
 */
async function verifyClerkToken(token) {
  if (!CLERK_SECRET_KEY || !token) return null;

  try {
    const payload = await Promise.race([
      verifyToken(token, { secretKey: CLERK_SECRET_KEY }),
      new Promise((resolve) => unref(setTimeout(() => resolve(null), VERIFY_TIMEOUT_MS))),
    ]);
    return typeof payload?.sub === "string" ? payload.sub : null;
  } catch (err) {
    // Once per process, not once per socket. A dev secret key on Railway makes
    // every token fail with *no visible symptom at all* — rooms work, nobody is
    // ever a member, and snapshots simply never appear. That is a very long
    // debugging session unless the process says so out loud exactly once.
    //
    // `err.reason` is Clerk's own machine-readable code; neither it nor
    // `err.message` echoes the token, but only the input is ever interpolated
    // here so that stays true regardless of what Clerk changes.
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
