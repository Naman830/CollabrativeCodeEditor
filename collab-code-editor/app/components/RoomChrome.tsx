"use client";

// One chrome bar for the room, replacing the two full-width rows the editor used
// to sit under (`UserBar` then `EditorToolbar`). Nothing was dropped — room id,
// sync state, language, presence, Run and Save are all still here, plus the
// theme toggle — but they now cost 48px instead of ~84px, which is the whole
// point on a laptop.
//
// Presentational only. Every value arrives as a prop from `CodeEditor`, so this
// file knows nothing about Yjs, and the peers it renders have already been
// through `readPeers`.

import Link from "next/link";
import PresenceStack from "./PresenceStack";
import ThemeToggle from "./ThemeToggle";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import type { SyncStatus } from "../hooks/useCollabRoom";
import type { Peer } from "../lib/awareness";
import { downloadFileName } from "../lib/languages";
import { shortcutLabel } from "../lib/platform";
import { cn, focusRing, runButton } from "../lib/ui";
import { CheckIcon, CopyIcon, DownloadIcon, LogoMark, PlayIcon } from "./icons";

const SYNC_LABEL: Record<SyncStatus, string> = {
  connected: "Synced",
  connecting: "Connecting…",
  disconnected: "Disconnected",
};

const SYNC_DOT: Record<SyncStatus, string> = {
  connected: "bg-success",
  connecting: "animate-pulse bg-warning",
  disconnected: "bg-danger",
};

/**
 * Room id, its sync light, and a click to copy. The three belong together: the
 * id is what you send someone, and the light says whether the thing you would be
 * sending them is currently live.
 */
function RoomChip({ roomId, syncStatus }: { roomId: string; syncStatus: SyncStatus }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => copy(roomId)}
      title={`${SYNC_LABEL[syncStatus]} · Copy room ID: ${roomId}`}
      aria-label={`Copy room ID ${roomId}. ${SYNC_LABEL[syncStatus]}.`}
      className={cn(
        "group flex min-w-0 items-center gap-2 rounded-lg border border-edge bg-raised/60 px-2.5 py-1.5",
        "text-xs text-fg-muted transition-colors hover:border-edge-strong hover:text-fg",
        focusRing,
      )}
    >
      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", SYNC_DOT[syncStatus])} />
      <span className="max-w-[7rem] truncate font-mono text-fg sm:max-w-[14rem]">{roomId}</span>
      <span aria-hidden className={copied ? "text-success" : "text-fg-subtle"}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </span>
      {/* Announced rather than shown: the tick above is the visible feedback. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Room ID copied" : ""}
      </span>
    </button>
  );
}

type RoomChromeProps = {
  roomId: string;
  /** Only for Save's filename hint — the selector itself lives on the file tab. */
  language: string;
  syncStatus: SyncStatus;
  peers: Peer[];
  /** Derived from shared state, so Run disables for every peer identically. */
  isRunning: boolean;
  onRun: () => void;
  /** False for an empty document — Save's only disabled state. */
  canSave: boolean;
  onSave: () => void;
};

export default function RoomChrome({
  roomId,
  language,
  syncStatus,
  peers,
  isRunning,
  onRun,
  canSave,
  onSave,
}: RoomChromeProps) {
  // §10.5's "show the binding in the Run and Save buttons' title". Read at
  // render, which is safe here: this tree only ever reaches the browser (see
  // `lib/platform.ts`).
  const runShortcut = shortcutLabel("Enter");
  const saveShortcut = shortcutLabel("S");

  return (
    // Wraps to two rows below `sm` rather than hiding controls behind a
    // breakpoint. An earlier draft hid the language select and the theme toggle
    // on phones, which is not a responsive layout — it is a smaller feature set.
    <header
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-edge bg-panel px-2 py-1.5",
        "sm:h-12 sm:flex-nowrap sm:px-3 sm:py-0",
      )}
    >
      <Link
        href="/"
        aria-label="Collaborative Code Editor home"
        title="Home"
        className={cn(
          "grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-strong text-white",
          focusRing,
        )}
      >
        <LogoMark className="h-4 w-4" />
      </Link>

      <RoomChip roomId={roomId} syncStatus={syncStatus} />

      <div className="ml-auto flex min-w-0 items-center gap-2">
        <PresenceStack peers={peers} connected={syncStatus === "connected"} />

        <span aria-hidden className="h-5 w-px bg-edge" />

        <ThemeToggle />

        <button
          type="button"
          onClick={onSave}
          // No room-wide lock here — Save touches no shared state, so an empty
          // editor is the only thing worth guarding against.
          disabled={!canSave}
          title={`Download ${downloadFileName(language)} (${saveShortcut})`}
          aria-label={`Save as ${downloadFileName(language)}`}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 py-1.5",
            "text-xs font-medium text-fg transition-colors hover:border-edge-strong hover:bg-edge",
            "disabled:cursor-not-allowed disabled:border-edge disabled:bg-transparent disabled:text-fg-subtle",
            focusRing,
          )}
        >
          <DownloadIcon />
          <span className="hidden lg:inline">Save</span>
        </button>

        <button
          type="button"
          onClick={onRun}
          disabled={isRunning}
          title={
            isRunning
              ? "Someone in this room is already running the code"
              : `Run the code (${runShortcut})`
          }
          className={cn(runButton, "px-3 text-xs sm:px-4")}
        >
          {isRunning ? (
            <span
              aria-hidden
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white"
            />
          ) : (
            <PlayIcon />
          )}
          {isRunning ? "Running…" : "Run"}
        </button>
      </div>
    </header>
  );
}
