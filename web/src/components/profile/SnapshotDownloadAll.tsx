"use client";

// Rendered only for a multi-file snapshot — one file already has its own Download.

import { useState } from "react";
import { PROJECT_ZIP_NAME, downloadZipFile } from "@/lib/editor/download";
import type { SnapshotFile } from "@/lib/data/deadRooms";
import { DownloadIcon } from "@/components/ui/icons";
import { cn, focusRing } from "@/lib/ui";

export default function SnapshotDownloadAll({ files }: { files: SnapshotFile[] }) {
  // JSZip loads via dynamic import, so a large snapshot has a visible gap after the click.
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
