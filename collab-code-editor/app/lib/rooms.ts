// The client's view of room lifetime. The sync server mints rooms, not the
// browser — an ID it never handed out is refused at connect time, which is what
// makes "this room doesn't exist" real rather than a client-side pretence.

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// ws:// -> http://, same host and port: the sync server serves its room routes
// and the WebSocket upgrade off one listener, so there is no second env var.
const API_URL = WS_URL.replace(/^ws/, "http");

/**
 * "missing" and "unreachable" must stay separate: sending someone home because
 * the server is down would claim their room is gone when it isn't.
 */
export type RoomCheck = "open" | "missing" | "unreachable";

export async function checkRoom(roomId: string): Promise<RoomCheck> {
  try {
    const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return "unreachable";
    const data: unknown = await res.json();
    const exists =
      typeof data === "object" && data !== null && (data as { exists?: unknown }).exists;
    return exists === true ? "open" : "missing";
  } catch {
    return "unreachable";
  }
}

/**
 * A refusal the server explained, as opposed to a network failure. Room
 * creation is rate limited, so "the server said no" is a state normal users
 * reach, and it needs the opposite reaction to a failed connection: wait,
 * rather than retry now.
 */
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
 * No request body on purpose: without a Content-Type this stays a CORS simple
 * request, so room creation costs no preflight round trip.
 */
export async function createRoom(): Promise<string> {
  const res = await fetch(`${API_URL}/rooms`, { method: "POST" });
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
