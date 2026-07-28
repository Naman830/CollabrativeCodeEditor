// The cap on what may be *sent* for execution — separate from the sandbox
// limits in `app/api/execute/route.ts`, which bound a running program.
//
// It lives here, not in the route, so the client can import it too: the route
// pulls in `next/server`, and a second copy of the number would drift.

/**
 * Largest program forwarded to Piston, in UTF-8 bytes. Far beyond anything
 * typed into an editor, and matches the output cap in `docker-compose.yml`.
 */
export const MAX_CODE_BYTES = 64 * 1024;

/**
 * UTF-8 byte length, not `String.length`: emoji and CJK are up to 4x their
 * character count on the wire, and the wire size is what is capped.
 */
export function codeByteLength(code: string): number {
  return new TextEncoder().encode(code).length;
}

/** Shared by the route's 413 and the client's pre-check, so both say the same. */
export const TOO_LARGE_MESSAGE = `Code is too large to run (limit ${Math.floor(
  MAX_CODE_BYTES / 1024
)} KB).`;
