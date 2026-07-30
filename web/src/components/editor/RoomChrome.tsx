"use client";

// Presentational only: every value is a prop, and the peers have already been
// through `readPeers`.

import Link from "next/link";
import PersistenceChip from "./PersistenceChip";
import PresenceStack from "./PresenceStack";
import ThemeToggle from "@/components/layout/ThemeToggle";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { SyncStatus } from "@/hooks/useCollabRoom";
import type { Peer } from "@/lib/collab/awareness";
import { languageLabel } from "@/lib/editor/languages";
import type { PersistenceStatus } from "@/lib/data/persistence";
import { shortcutLabel } from "@/lib/platform";
import { chip, cn, focusRing, runButton } from "@/lib/ui";
import { CheckIcon, CopyIcon, DownloadIcon, LogoMark, PlayIcon } from "@/components/ui/icons";

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
      {/* Announced, not shown: the tick above is the visible feedback. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Room ID copied" : ""}
      </span>
    </button>
  );
}

type RoomChromeProps = {
  roomId: string;
  /** Chosen once at room creation and fixed for its lifetime. */
  language: string;
  /** One filename, or `project.zip` for a multi-file room. */
  saveName: string;
  syncStatus: SyncStatus;
  peers: Peer[];
  /** Derived from shared state, so Run disables for every peer identically. */
  isRunning: boolean;
  /** The file Run executes, which need not be the tab you have open. */
  entryFileName: string | null;
  onRun: () => void;
  canSave: boolean;
  onSave: () => void;
  persistenceStatus: PersistenceStatus;
  persistenceRemainingMs: number;
  isLastPeer: boolean;
};

export default function RoomChrome({
  roomId,
  language,
  saveName,
  syncStatus,
  peers,
  isRunning,
  entryFileName,
  onRun,
  canSave,
  onSave,
  persistenceStatus,
  persistenceRemainingMs,
  isLastPeer,
}: RoomChromeProps) {
  const runShortcut = shortcutLabel("Enter");
  const saveShortcut = shortcutLabel("S");

  return (
    // Wraps to two rows below `sm` rather than hiding controls behind a breakpoint.
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

      {/* Read-only: changing the language mid-room would make every file's extension a lie. */}
      <span
        className={cn(chip, "hidden shrink-0 sm:inline-flex")}
        title="Chosen when this room was created and fixed for its lifetime"
      >
        {languageLabel(language)}
      </span>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        <PersistenceChip
          status={persistenceStatus}
          remainingMs={persistenceRemainingMs}
          isLastPeer={isLastPeer}
        />

        <PresenceStack peers={peers} connected={syncStatus === "connected"} />

        <span aria-hidden className="h-5 w-px bg-edge" />

        <ThemeToggle />

        <button
          type="button"
          onClick={onSave}
          // No room-wide lock: Save touches no shared state.
          disabled={!canSave}
          title={`Download ${saveName} (${saveShortcut})`}
          aria-label={`Save as ${saveName}`}
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
          // Names the entry file: Run may execute a file other than the open one.
          title={
            isRunning
              ? "Someone in this room is already running the code"
              : entryFileName
                ? `Run ${entryFileName} (${runShortcut})`
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
