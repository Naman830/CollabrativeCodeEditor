"use client";

// "Download all" for a multi-file snapshot (tasks.md §10.1).
//
// Rendered only when a snapshot holds more than one file, because for a single
// file it would produce a zip containing exactly what `SnapshotActions`' own
// Download button already hands over uncompressed.
//
// Same promise as every other download in this app: the archive is built in the
// browser from data already on the page, and nothing is written anywhere.

import { useState } from "react";
import { PROJECT_ZIP_NAME, downloadZipFile } from "@/lib/editor/download";
import type { SnapshotFile } from "@/lib/data/deadRooms";
import { DownloadIcon } from "@/components/ui/icons";
import { cn, focusRing } from "@/lib/ui";

export default function SnapshotDownloadAll({ files }: { files: SnapshotFile[] }) {
  // JSZip arrives through a dynamic import and the archive is built off the main
  // thread's critical path, so a large snapshot has a visible gap between the
  // click and the download. Without this the button looks dead.
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadZipFile(files);
        } finally {
          setBusy(false);
        }
      }}
      title={`Download all ${files.length} files as ${PROJECT_ZIP_NAME}`}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border border-edge bg-raised px-3 py-1.5 text-xs font-medium text-fg",
        "transition-colors hover:border-edge-strong hover:bg-edge disabled:cursor-not-allowed disabled:text-fg-subtle",
        focusRing,
      )}
    >
      <DownloadIcon />
      {busy ? "Zipping…" : `Download all (${files.length})`}
    </button>
  );
}
