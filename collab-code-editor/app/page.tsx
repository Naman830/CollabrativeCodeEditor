"use client";

import { useState, type SubmitEventHandler } from "react";
import { useRouter } from "next/navigation";
import IdentityDialog from "./components/IdentityDialog";
import { createRoom } from "./lib/rooms";
import { setActiveUser, type CollabUser } from "./lib/user";

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");
  // True while the identity dialog for a new room is open. The room's ID isn't
  // known until submit — the server mints it, so that a room ID the server never
  // handed out can be refused at connect time.
  const [creating, setCreating] = useState(false);
  // Separate from `creating`: the dialog is open the whole time, but only
  // reserving is in flight.
  const [reserving, setReserving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const goToRoom = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    router.push(`/room/${encodeURIComponent(trimmed)}`);
  };

  const handleJoin: SubmitEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    goToRoom(roomId);
  };

  // Creating asks who you are first; the redirect happens on dialog submit.
  // Joining deliberately does not prompt here — the room itself prompts, which
  // covers typed room IDs and pasted deep links with one code path, and RoomGate
  // there is what turns a room ID that no longer exists into a trip home.
  const handleCreate = () => {
    setCreateError(null);
    setCreating(true);
  };

  const handleIdentitySubmit = async (user: CollabUser) => {
    setActiveUser(user);
    setReserving(true);
    try {
      // Fails closed: better an error here than dropping someone into a room
      // that provably does not exist and can never sync.
      const newRoomId = await createRoom();
      goToRoom(newRoomId);
    } catch {
      setCreating(false);
      setCreateError("Couldn't reach the sync server. Please try again.");
    } finally {
      setReserving(false);
    }
  };

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-[#1e1e1e] text-zinc-200">
      <div className="flex flex-col items-center gap-1">
        <h1 className="text-2xl font-semibold">Collaborative Code Editor</h1>
        <p className="text-sm text-zinc-400">
          Join an existing room or create a new one to start pairing.
        </p>
      </div>

      <form onSubmit={handleJoin} className="flex items-center gap-2">
        <input
          type="text"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="Enter room ID"
          className="w-56 rounded border border-zinc-700 bg-[#3c3c3c] px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        >
          Join Room
        </button>
      </form>

      <div className="flex items-center gap-3 text-xs text-zinc-500">
        <span className="h-px w-12 bg-zinc-700" />
        or
        <span className="h-px w-12 bg-zinc-700" />
      </div>

      <button
        type="button"
        onClick={handleCreate}
        className="rounded border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
      >
        Create New Room
      </button>

      {createError && (
        <p role="alert" className="text-sm text-red-400">
          {createError}
        </p>
      )}

      {creating && (
        <IdentityDialog
          title="Create a room"
          description="Pick a name so everyone can tell your cursor apart."
          submitLabel="Create & Enter"
          onSubmit={handleIdentitySubmit}
          onCancel={reserving ? undefined : () => setCreating(false)}
          busy={reserving}
        />
      )}
    </div>
  );
}
