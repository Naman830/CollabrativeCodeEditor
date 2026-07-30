"use client";

// The only interactive part of a dead room: copy the code, or download it.
//
// Both are the same promise v1 made about Save — "saving a file means
// downloading it to your device". Nothing here writes anything anywhere; a
// snapshot is read-only forever (tasks.md §6, §8).

import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { downloadTextFile } from "@/lib/download";
import { CheckIcon, CopyIcon, DownloadIcon } from "@/components/ui/icons";

type SnapshotActionsProps = {
  filename: string;
  content: string;
};

export default function SnapshotActions({ filename, content }: SnapshotActionsProps) {
  const { copied, copy } = useCopyToClipboard();

  const buttonClass =
    "flex items-center gap-1.5 rounded-lg border border-edge bg-raised/60 px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:border-edge-strong hover:text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:text-fg-subtle";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => copy(content)}
        disabled={content.length === 0}
        title={`Copy the contents of ${filename}`}
        className={buttonClass}
      >
        <span className={copied ? "text-success" : "text-fg-muted"}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </span>
        {copied ? "Copied" : "Copy code"}
        <span aria-live="polite" className="sr-only">
          {copied ? "Code copied" : ""}
        </span>
      </button>

      <button
        type="button"
        onClick={() => downloadTextFile(filename, content)}
        disabled={content.length === 0}
        title={`Download ${filename}`}
        className={buttonClass}
      >
        <DownloadIcon />
        Download
      </button>
    </div>
  );
}
