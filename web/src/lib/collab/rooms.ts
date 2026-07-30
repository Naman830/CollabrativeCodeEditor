// The client's view of room lifetime. The sync server mints room IDs, not the browser.

import { DEFAULT_LANGUAGE, isLanguage, type LanguageValue } from "@/lib/editor/languages";

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// ws:// -> http://: one listener serves the room routes and the upgrade, so there is
// deliberately no second env var to drift.
const API_URL = WS_URL.replace(/^ws/, "http");

// INVARIANT: "missing" and "unreachable" stay separate — a down server must not be
// reported as a room that is gone.
export type RoomCheck = "open" | "missing" | "unreachable";

// `language` is the room's, chosen once at creation; only meaningful when status is "open".
export type RoomStatus = {
  status: RoomCheck;
  language: LanguageValue;
};

export async function checkRoom(roomId: string): Promise<RoomStatus> {
  try {
    const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return { status: "unreachable", language: DEFAULT_LANGUAGE };
    const data: unknown = await res.json();
    const body = (typeof data === "object" && data !== null ? data : {}) as {
      exists?: unknown;
      language?: unknown;
    };
    return {
      status: body.exists === true ? "open" : "missing",
      // Narrowed, not trusted: a cross-origin value that picks a tokenizer and a runtime.
      language: isLanguage(body.language) ? body.language : DEFAULT_LANGUAGE,
    };
  } catch {
    return { status: "unreachable", language: DEFAULT_LANGUAGE };
  }
}

// A refusal the server explained (it is rate limited), which callers must not report as
// unreachable: the reactions are opposite — wait, rather than retry now.
export class RoomCreateError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RoomCreateError";
    this.status = status;
  }
}

/**
 * Reserves a room and returns its ID. Throws if the server can't be reached —
 * the caller must show that rather than enter a room that doesn't exist.
 *
 * Still no request body: without a Content-Type this stays a CORS **simple**
 * request, so room creation costs no preflight round trip. That is exactly why
 * §10.1's language travels as a query parameter and not as JSON — a body would
 * buy a whole extra round trip before every room creation, for one word.
 */
export async function createRoom(language: LanguageValue): Promise<string> {
  const res = await fetch(`${API_URL}/rooms?language=${encodeURIComponent(language)}`, {
    method: "POST",
  });
  if (!res.ok) {
    // Prefer the server's own wording — it knows why it refused.
    const explained = await res
      .json()
      .then((data: unknown) =>
        typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : null
      )
      .catch(() => null);
    throw new RoomCreateError(explained ?? `Room creation failed (${res.status})`, res.status);
  }
  const data: unknown = await res.json();
  const roomId =
    typeof data === "object" && data !== null
      ? (data as { roomId?: unknown }).roomId
      : undefined;
  if (typeof roomId !== "string" || roomId.length === 0) {
    throw new Error("Room creation returned no room ID");
  }
  return roomId;
}
