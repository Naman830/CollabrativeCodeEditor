// INVARIANT: the sent-payload cap lives here, not in the execute route (which
// pulls in next/server), so the client pre-check and the route's 413 share it.

export const MAX_CODE_BYTES = 64 * 1024;

/** UTF-8 bytes, not `String.length` — the wire size is what is capped. */
export function codeByteLength(code: string): number {
  return new TextEncoder().encode(code).length;
}

export const TOO_LARGE_MESSAGE = `Code is too large to run (limit ${Math.floor(
  MAX_CODE_BYTES / 1024
)} KB).`;

export const TOO_LARGE_WITH_STDIN_MESSAGE = `Code and input are too large to run (limit ${Math.floor(
  MAX_CODE_BYTES / 1024
)} KB combined).`;

// INVARIANT: one combined code+stdin budget. A per-field cap would need
// REQUEST_BYTE_CEILING in the execute route raised in the same change.
export function payloadTooLarge(code: string, stdin: string): string | null {
  if (codeByteLength(code) + codeByteLength(stdin) <= MAX_CODE_BYTES) return null;
  return stdin.length > 0 ? TOO_LARGE_WITH_STDIN_MESSAGE : TOO_LARGE_MESSAGE;
}
