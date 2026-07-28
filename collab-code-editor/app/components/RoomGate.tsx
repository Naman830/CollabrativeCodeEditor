"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import CodeEditor from "./CodeEditor";
import { checkRoom } from "../lib/rooms";

// Long enough to read why you were bounced, short enough not to feel stuck.
const REDIRECT_SECONDS = 3;

type GateState = "checking" | "open" | "missing" | "unreachable";

type RoomGateProps = {
  roomId: string;
};

/**
 * Decides whether this room may be entered — *before* `CodeEditor` mounts.
 * Mounting the editor opens the WebSocket, and connecting is what creates the
 * room on the server, so a check running alongside it would revive dead rooms.
 */
export default function RoomGate({ roomId }: RoomGateProps) {
  const router = useRouter();
  const [state, setState] = useState<GateState>("checking");
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_SECONDS);
  // Bumped by Retry to re-run the check below.
  const [attempt, setAttempt] = useState(0);

  // No "checking" reset here: `retry` does it, and `roomId` can't change
  // without a remount (the route keys this component on it).
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

  // A room can also die mid-session (evicted, or the server restarted). The
  // editor's reconnect is refused and it reports that here.
  const handleRoomClosed = useCallback(() => {
    setSecondsLeft(REDIRECT_SECONDS);
    setState("missing");
  }, []);

  // `replace`, not `push`: Back must not land in the dead room again.
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

  const primaryButton =
    "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-lg shadow-accent/20 transition-colors hover:bg-accent-strong";
  const secondaryButton =
    "rounded-lg border border-edge bg-raised px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-[#2c2c2c]";

  return (
    <div className="relative flex h-full flex-col items-center justify-center px-6 text-center text-zinc-300">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(45rem_30rem_at_50%_0%,rgba(76,141,255,0.10),transparent_70%)]"
      />

      {state === "checking" && (
        <div className="relative flex flex-col items-center gap-3">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-edge border-t-accent" />
          <p className="text-sm text-zinc-400">Checking room…</p>
        </div>
      )}

      {state === "missing" && (
        <div className="relative flex max-w-sm flex-col items-center gap-4 rounded-2xl border border-edge bg-panel/80 p-8 shadow-2xl shadow-black/40 backdrop-blur">
          <span className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-raised text-xl">
            🔒
          </span>
          <h1 className="text-xl font-semibold text-zinc-50">This room has closed</h1>
          <p className="text-sm text-zinc-400">
            Rooms live only while someone is in them — this one disappeared when the last
            person left. Create a new room to start again.
          </p>
          <button type="button" onClick={goHome} className={primaryButton}>
            Back to home
          </button>
          <p className="text-xs text-zinc-500" aria-live="polite">
            Redirecting in {secondsLeft}s…
          </p>
        </div>
      )}

      {/* Not the screen above: the room may be alive and simply unverifiable, so
          this offers a retry instead of sending someone away from it. */}
      {state === "unreachable" && (
        <div className="relative flex max-w-sm flex-col items-center gap-4 rounded-2xl border border-edge bg-panel/80 p-8 shadow-2xl shadow-black/40 backdrop-blur">
          <span className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-raised text-xl">
            📡
          </span>
          <h1 className="text-xl font-semibold text-zinc-50">
            Couldn&apos;t reach the sync server
          </h1>
          <p className="text-sm text-zinc-400">
            We can&apos;t tell whether this room is still open. Check your connection and try
            again.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={retry} className={primaryButton}>
              Retry
            </button>
            <button type="button" onClick={goHome} className={secondaryButton}>
              Back to home
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
