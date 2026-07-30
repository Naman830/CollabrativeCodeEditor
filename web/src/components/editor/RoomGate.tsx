"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { DEFAULT_LANGUAGE, type LanguageValue } from "@/lib/editor/languages";
import { checkRoom } from "@/lib/collab/rooms";
import { card, primaryButton, secondaryButton } from "@/lib/ui";
import { LockIcon, WifiOffIcon } from "@/components/ui/icons";

const REDIRECT_SECONDS = 3;

// INVARIANT: `ssr: false` — `CodeEditor` imports `monaco-editor` at module scope,
// which touches `window`. At module scope so the reference never remounts the editor.
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

/** INVARIANT: must decide before `CodeEditor` mounts — mounting opens the socket, which revives a dead room. */
export default function RoomGate({ roomId }: RoomGateProps) {
  const router = useRouter();
  const [state, setState] = useState<GateState>("checking");
  // The room's language, server-authoritative: it arrives with the existence check.
  const [language, setLanguage] = useState<LanguageValue>(DEFAULT_LANGUAGE);
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_SECONDS);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    checkRoom(roomId).then((result) => {
      if (cancelled) return;
      setLanguage(result.language);
      setState(result.status);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, attempt]);

  const retry = useCallback(() => {
    setState("checking");
    setAttempt((n) => n + 1);
  }, []);

  // A room can also die mid-session: the editor's refused reconnect reports here.
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
    return (
      <CodeEditor roomId={roomId} language={language} onRoomClosed={handleRoomClosed} />
    );
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

      {/* Distinct from `missing`: the room may be alive and merely unverifiable, so offer a retry. */}
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
