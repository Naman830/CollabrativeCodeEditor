"use client";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import type { SyncStatus } from "../hooks/useCollabRoom";
import { LANGUAGES, downloadFileName } from "../lib/languages";
import { CheckIcon, CopyIcon, DownloadIcon, PlayIcon } from "./icons";

function RoomIdChip({ roomId }: { roomId: string }) {
  const { copied, copy } = useCopyToClipboard();

  // The chip truncates a long id, so the button is the only way to get the
  // whole thing without retyping it out of the address bar.
  return (
    <button
      type="button"
      onClick={() => copy(roomId)}
      title={`Copy room ID: ${roomId}`}
      aria-label={`Copy room ID ${roomId}`}
      className="flex min-w-0 items-center gap-1.5 rounded-lg border border-edge bg-raised/60 px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
    >
      Room
      <span className="max-w-[14rem] truncate font-mono text-zinc-300">{roomId}</span>
      <span className={copied ? "text-emerald-400" : "text-zinc-500"}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </span>
      <span aria-live="polite" className="sr-only">
        {copied ? "Room ID copied" : ""}
      </span>
    </button>
  );
}

function SyncStatusPill({ status }: { status: SyncStatus }) {
  return (
    <span className="flex items-center gap-2 rounded-lg border border-edge bg-raised/60 px-2.5 py-1.5 text-xs text-zinc-400">
      <span
        className={`h-2 w-2 rounded-full ${
          status === "connected"
            ? "bg-emerald-500"
            : status === "connecting"
              ? "animate-pulse bg-amber-500"
              : "bg-red-500"
        }`}
      />
      {status === "connected"
        ? "Synced"
        : status === "connecting"
          ? "Connecting…"
          : "Disconnected"}
    </span>
  );
}

type EditorToolbarProps = {
  roomId: string;
  /** A per-user editing preference — never shared state. */
  language: string;
  onLanguageChange: (language: string) => void;
  syncStatus: SyncStatus;
  /** Derived from shared state, so Run disables for every peer identically. */
  isRunning: boolean;
  onRun: () => void;
  /** False for an empty document — Save's only disabled state. */
  canSave: boolean;
  onSave: () => void;
};

/** The row above the editor: language, room id, sync status, Run and Save. */
export default function EditorToolbar({
  roomId,
  language,
  onLanguageChange,
  syncStatus,
  isRunning,
  onRun,
  canSave,
  onSave,
}: EditorToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-panel px-4 py-2">
      <label htmlFor="language-select" className="sr-only">
        Language
      </label>
      <select
        id="language-select"
        value={language}
        onChange={(e) => onLanguageChange(e.target.value)}
        className="rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-sm text-zinc-100 transition-colors hover:border-zinc-600 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.label}
          </option>
        ))}
      </select>

      <RoomIdChip roomId={roomId} />

      <div className="ml-auto flex items-center gap-2">
        <SyncStatusPill status={syncStatus} />

        <button
          type="button"
          onClick={onRun}
          disabled={isRunning}
          className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-lg shadow-emerald-600/20 transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-raised disabled:text-zinc-500 disabled:shadow-none"
        >
          {isRunning ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-500/40 border-t-zinc-300" />
          ) : (
            <PlayIcon />
          )}
          {isRunning ? "Running…" : "Run"}
        </button>

        <button
          type="button"
          onClick={onSave}
          // No room-wide lock here — Save touches no shared state, so an empty
          // editor is the only thing worth guarding against.
          disabled={!canSave}
          title={`Download ${downloadFileName(language)}`}
          className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-4 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-[#2c2c2c] disabled:cursor-not-allowed disabled:border-edge disabled:bg-transparent disabled:text-zinc-600"
        >
          <DownloadIcon />
          Save
        </button>
      </div>
    </div>
  );
}
