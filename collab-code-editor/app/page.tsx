"use client";

import { useState, type SubmitEventHandler } from "react";
import { useRouter } from "next/navigation";
import IdentityDialog from "./components/IdentityDialog";
import { setActiveUser, type CollabUser } from "./lib/user";

// Full UUID, not a truncation of one: a room ID is the only thing standing
// between a stranger and the document, so it has to be unguessable.
function generateRoomId(): string {
  return crypto.randomUUID();
}

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");
  // Non-null while the identity dialog is open — holds the ID the room will get
  // once a name has been entered.
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);

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
  // covers typed room IDs and pasted deep links with one code path.
  const handleCreate = () => {
    setPendingRoomId(generateRoomId());
  };

  const handleIdentitySubmit = (user: CollabUser) => {
    setActiveUser(user);
    if (pendingRoomId) goToRoom(pendingRoomId);
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

      {pendingRoomId && (
        <IdentityDialog
          title="Create a room"
          description="Pick a name so everyone can tell your cursor apart."
          submitLabel="Create & Enter"
          onSubmit={handleIdentitySubmit}
          onCancel={() => setPendingRoomId(null)}
        />
      )}
    </div>
  );
}
