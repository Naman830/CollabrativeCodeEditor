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

/** The same cap, worded for a request that also carried stdin (tasks.md §10.4). */
export const TOO_LARGE_WITH_STDIN_MESSAGE = `Code and input are too large to run (limit ${Math.floor(
  MAX_CODE_BYTES / 1024
)} KB combined).`;

/**
 * The single budget rule, so the client pre-check and the route's 413 cannot
 * drift — the same reason `codeByteLength` lives here rather than in the route.
 *
 * §10.4 says to count stdin "against the same UTF-8 byte budget as the code", so
 * this is one combined allowance rather than two. That reading is also what lets
 * `REQUEST_BYTE_CEILING` in the route stay untouched: the decoded payload still
 * caps at `MAX_CODE_BYTES`, so the existing "doubled for JSON escaping" headroom
 * still covers the whole envelope.
 *
 * Returns the message to show, or null when the payload is within budget.
 */
export function payloadTooLarge(code: string, stdin: string): string | null {
  if (codeByteLength(code) + codeByteLength(stdin) <= MAX_CODE_BYTES) return null;
  return stdin.length > 0 ? TOO_LARGE_WITH_STDIN_MESSAGE : TOO_LARGE_MESSAGE;
}
