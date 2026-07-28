// Limits on what may be *sent* for execution. Separate from the sandbox-side
// limits in `app/api/execute/route.ts` (which bound what a program may do once
// it is running) — this is the bound on the request itself.
//
// It lives in `lib/` rather than in the route for the same reason the language
// table does: the route imports `next/server`, so the client cannot import from
// it, and a client-side pre-check would otherwise be a second copy of the number
// that silently drifts.

/**
 * Largest program we will forward to Piston, in UTF-8 bytes.
 *
 * 64 KB is far beyond anything typed or pasted into an editor pane, and matches
 * the 64 KB per-stream output cap set in `docker-compose.yml` — the request and
 * the response are bounded by the same order of magnitude.
 */
export const MAX_CODE_BYTES = 64 * 1024;

/**
 * UTF-8 byte length, not `String.length`. A document of emoji or CJK is up to
 * 4x its character count on the wire, and it is the wire size we are capping.
 */
export function codeByteLength(code: string): number {
  return new TextEncoder().encode(code).length;
}

/** Shared by the route's 413 and the client's pre-flight check, so both say the same thing. */
export const TOO_LARGE_MESSAGE = `Code is too large to run (limit ${Math.floor(
  MAX_CODE_BYTES / 1024
)} KB).`;
