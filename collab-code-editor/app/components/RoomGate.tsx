"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import CodeEditor from "./CodeEditor";
import { checkRoom } from "../lib/rooms";

// Seconds the closed-room screen stays up before it sends you home. Long enough
// to read why you were bounced, short enough not to feel stuck.
const REDIRECT_SECONDS = 3;

type GateState = "checking" | "open" | "missing" | "unreachable";

type RoomGateProps = {
  roomId: string;
};

/**
 * Decides whether this room may be entered at all, and — crucially — does it
 * *before* `CodeEditor` mounts. Mounting the editor opens the WebSocket, and
 * connecting is what would create the room (`setupWSConnection` calls
 * `map.setIfUndefined` on the server's docs map), so a check that ran alongside
 * the editor rather than ahead of it would bring the dead room back to life.
 */
export default function RoomGate({ roomId }: RoomGateProps) {
  const router = useRouter();
  const [state, setState] = useState<GateState>("checking");
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_SECONDS);
  // Bumped by Retry to re-run the check effect below.
  const [attempt, setAttempt] = useState(0);

  // No `setState("checking")` here to reset on re-run: `attempt` is only bumped
  // by `retry`, which does that reset itself, and `roomId` cannot change without
  // a remount (the room route keys this component on it).
  useEffect(() => {
    let cancelled = false;
    checkRoom(roomId).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, attempt]);

  const retry = useCallback(() => {
    setState("checking");
    setAttempt((n) => n + 1);
  }, []);

  // A room can also die *under* an open session — evicted, or the server
  // restarted, while this client's socket was down — in which case its
  // reconnect is refused and the editor reports it here.
  const handleRoomClosed = useCallback(() => {
    setSecondsLeft(REDIRECT_SECONDS);
    setState("missing");
  }, []);

  // `replace`, not `push`: Back must not drop the user into the dead room again.
  const goHome = useCallback(() => {
    router.replace("/");
  }, [router]);

  useEffect(() => {
    if (state !== "missing") return;
    const tick = setInterval(() => {
      setSecondsLeft((left) => Math.max(0, left - 1));
    }, 1000);
    const redirect = setTimeout(goHome, REDIRECT_SECONDS * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(redirect);
    };
  }, [state, goHome]);

  if (state === "open") {
    return <CodeEditor roomId={roomId} onRoomClosed={handleRoomClosed} />;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-zinc-300">
      {state === "checking" && (
        <>
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" />
          <p className="text-sm text-zinc-400">Checking room…</p>
        </>
      )}

      {state === "missing" && (
        <>
          <h1 className="text-xl font-semibold text-zinc-100">This room has closed</h1>
          <p className="max-w-sm text-sm text-zinc-400">
            Rooms live only while someone is in them — this one disappeared when the last
            person left. Create a new room to start again.
          </p>
          <button
            type="button"
            onClick={goHome}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            Back to home
          </button>
          <p className="text-xs text-zinc-500" aria-live="polite">
            Redirecting in {secondsLeft}s…
          </p>
        </>
      )}

      {/* Deliberately not the screen above: the room may be perfectly alive and
          simply unverifiable right now, so this offers a retry instead of
          redirecting someone away from a room that still exists. */}
      {state === "unreachable" && (
        <>
          <h1 className="text-xl font-semibold text-zinc-100">
            Couldn&apos;t reach the sync server
          </h1>
          <p className="max-w-sm text-sm text-zinc-400">
            We can&apos;t tell whether this room is still open. Check your connection and try
            again.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={retry}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={goHome}
              className="rounded border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
            >
              Back to home
            </button>
          </div>
        </>
      )}
    </div>
  );
}
