"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { checkRoom } from "../lib/rooms";
import { card, primaryButton, secondaryButton } from "../lib/ui";
import { LockIcon, WifiOffIcon } from "./icons";

// Long enough to read why you were bounced, short enough not to feel stuck.
const REDIRECT_SECONDS = 3;

// `ssr: false` for two reasons, one old and one new.
//
// Old: `CodeEditor` calls `configureMonacoLoader()` at module scope, which
// imports `monaco-editor`, which touches `window` at import time. Server
// rendering this route has therefore always thrown — `/room/<id>` answered HTTP
// 500 on every request and the browser silently recovered. This turns a
// 500-and-recover into an ordinary client-side chunk load, so the route finally
// server-renders, and the root layout's no-flash theme script actually ships
// with it.
//
// New: `useRoomLayout` restores the split from localStorage. With no server
// render there is no first paint for a restored 30/70 to disagree with, so the
// panels' inline flex-grow can never hydrate-mismatch.
//
// `ssr: false` is only legal in a Client Component, which this file is —
// `room/[roomId]/page.tsx` is a Server Component and would error. Declared at
// module scope so the reference is stable and never remounts the editor.
const CodeEditor = dynamic(() => import("./CodeEditor"), {
  ssr: false,
  loading: () => <GateSpinner label="Loading the editor…" />,
});

type GateState = "checking" | "open" | "missing" | "unreachable";

type RoomGateProps = {
  roomId: string;
};

function GateSpinner({ label }: { label: string }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-3">
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-edge border-t-accent" />
      <p className="text-sm text-fg-muted">{label}</p>
    </div>
  );
}

function GateIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-raised text-fg-muted">
      {children}
    </span>
  );
}

function GateCard({
  icon,
  title,
  children,
  actions,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className={`relative flex max-w-sm flex-col items-center gap-4 p-8 ${card}`}>
      <GateIcon>{icon}</GateIcon>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <p className="text-sm text-fg-muted">{children}</p>
      <div className="flex items-center gap-2">{actions}</div>
      {footer}
    </div>
  );
}

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

  return (
    <div className="wash relative flex h-full flex-col items-center justify-center px-6 text-center text-fg-muted">
      {state === "checking" && <GateSpinner label="Checking room…" />}

      {state === "missing" && (
        <GateCard
          icon={<LockIcon className="h-5 w-5" />}
          title="This room has closed"
          actions={
            <button type="button" onClick={goHome} className={primaryButton}>
              Back to home
            </button>
          }
          footer={
            <p className="text-xs text-fg-subtle" aria-live="polite">
              Redirecting in {secondsLeft}s…
            </p>
          }
        >
          Rooms live only while someone is in them — this one disappeared when the last person
          left. Create a new room to start again.
        </GateCard>
      )}

      {/* Not the screen above: the room may be alive and simply unverifiable, so
          this offers a retry instead of sending someone away from it. */}
      {state === "unreachable" && (
        <GateCard
          icon={<WifiOffIcon className="h-5 w-5" />}
          title="Couldn't reach the sync server"
          actions={
            <>
              <button type="button" onClick={retry} className={primaryButton}>
                Retry
              </button>
              <button type="button" onClick={goHome} className={secondaryButton}>
                Back to home
              </button>
            </>
          }
        >
          We can&apos;t tell whether this room is still open. Check your connection and try again.
        </GateCard>
      )}
    </div>
  );
}
