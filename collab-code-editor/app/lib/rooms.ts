// The client's view of room lifetime. Rooms are created by the sync server, not
// by the browser: a room ID the server never handed out is refused at connect
// time, which is what makes "this room doesn't exist" a real state rather than
// something the client could only pretend to enforce.

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// ws:// -> http://, wss:// -> https:// — same host, same port. The sync server
// serves its room routes and the WebSocket upgrade off one listener, so there is
// deliberately no second env var to keep in sync with this one.
const API_URL = WS_URL.replace(/^ws/, "http");

/**
 * "missing" and "unreachable" must never collapse into one state: bouncing
 * someone home because the sync server is down would tell them their room is
 * gone when it is not.
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
 * creation is rate limited per IP, so "the server said no" is now a state a
 * normal user can reach, and it must not be reported as "couldn't reach the
 * sync server" — the two call for opposite reactions (wait vs retry now).
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
 * the caller must surface that rather than navigating into a room that
 * provably does not exist.
 *
 * No request body on purpose: without a Content-Type header this stays a CORS
 * simple request, so there is no preflight before every room creation.
 */
export async function createRoom(): Promise<string> {
  const res = await fetch(`${API_URL}/rooms`, { method: "POST" });
  if (!res.ok) {
    // The server's own wording when it has one (rate limit, reservation
    // ceiling); it knows why it refused and we do not.
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
