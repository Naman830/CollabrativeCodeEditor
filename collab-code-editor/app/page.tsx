"use client";

import { useState, type SubmitEventHandler } from "react";
import { useRouter } from "next/navigation";
import IdentityDialog from "./components/IdentityDialog";
import { RoomCreateError, createRoom } from "./lib/rooms";
import { setActiveUser, type CollabUser } from "./lib/user";

const FEATURES = ["Live cursors", "Sandboxed runs", "No sign-up"];

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");
  // The identity dialog for a new room is open. The ID isn't known until submit
  // — the server mints it, so an ID it never handed out can be refused later.
  const [creating, setCreating] = useState(false);
  // The dialog stays open the whole time; only the reservation is in flight.
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

  // Creating asks who you are first. Joining doesn't: the room itself prompts,
  // which covers typed IDs and pasted links with one code path.
  const handleCreate = () => {
    setCreateError(null);
    setCreating(true);
  };

  const handleIdentitySubmit = async (user: CollabUser) => {
    setActiveUser(user);
    setReserving(true);
    try {
      // Fails closed: an error here beats entering a room that can never sync.
      const newRoomId = await createRoom();
      goToRoom(newRoomId);
    } catch (err) {
      setCreating(false);
      // A server that answered and refused said why; only an unanswered
      // request is a reachability problem.
      setCreateError(
        err instanceof RoomCreateError
          ? err.message
          : "Couldn't reach the sync server. Please try again."
      );
    } finally {
      setReserving(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(55rem_35rem_at_50%_-15%,rgba(76,141,255,0.16),transparent_70%)]"
      />

      <div className="relative w-full max-w-md">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-strong shadow-lg shadow-accent/20">
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-6 w-6 text-white"
            >
              <path d="m9 8-4 4 4 4" />
              <path d="m15 8 4 4-4 4" />
            </svg>
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">
              Collaborative Code Editor
            </h1>
            <p className="text-sm text-zinc-400">
              Write and run code together, in the same room, in real time.
            </p>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-edge bg-panel/80 p-6 shadow-2xl shadow-black/40 backdrop-blur">
          <form onSubmit={handleJoin} className="flex flex-col gap-2">
            <label htmlFor="room-id" className="text-xs font-medium text-zinc-400">
              Have a room ID?
            </label>
            <input
              id="room-id"
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="Paste or type a room ID"
              className="w-full rounded-lg border border-edge bg-raised px-3 py-2.5 font-mono text-sm text-zinc-100 placeholder:font-sans placeholder:text-zinc-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <button
              type="submit"
              className="mt-1 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-accent/20 transition-colors hover:bg-accent-strong"
            >
              Join room
            </button>
          </form>

          <div className="my-5 flex items-center gap-3 text-[11px] font-medium uppercase tracking-widest text-zinc-600">
            <span className="h-px flex-1 bg-edge" />
            or
            <span className="h-px flex-1 bg-edge" />
          </div>

          <button
            type="button"
            onClick={handleCreate}
            className="w-full rounded-lg border border-edge bg-raised px-4 py-2.5 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-600 hover:bg-[#2c2c2c]"
          >
            Create a new room
          </button>

          {createError && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
            >
              {createError}
            </p>
          )}
        </div>

        <ul className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {FEATURES.map((feature) => (
            <li
              key={feature}
              className="rounded-full border border-edge bg-panel/60 px-3 py-1 text-xs text-zinc-400"
            >
              {feature}
            </li>
          ))}
        </ul>
      </div>

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
    </main>
  );
}
