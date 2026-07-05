"use client";

import { useState, type SubmitEventHandler } from "react";
import { useRouter } from "next/navigation";

function generateRoomId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");

  const goToRoom = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    router.push(`/room/${encodeURIComponent(trimmed)}`);
  };

  const handleJoin: SubmitEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    goToRoom(roomId);
  };

  const handleCreate = () => {
    goToRoom(generateRoomId());
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
    </div>
  );
}
