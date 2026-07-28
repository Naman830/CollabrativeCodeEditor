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
 * Reserves a room and returns its ID. Throws if the server can't be reached —
 * the caller must surface that rather than navigating into a room that
 * provably does not exist.
 *
 * No request body on purpose: without a Content-Type header this stays a CORS
 * simple request, so there is no preflight before every room creation.
 */
export async function createRoom(): Promise<string> {
  const res = await fetch(`${API_URL}/rooms`, { method: "POST" });
  if (!res.ok) throw new Error(`Room creation failed (${res.status})`);
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
