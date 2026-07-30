export const PROJECT_ZIP_NAME = "project.zip";

// Shape matches `SnapshotFile` in `lib/data/deadRooms.ts`.
export type DownloadableFile = {
  filename: string;
  content: string;
};

function clickDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadTextFile(filename: string, contents: string): void {
  clickDownload(filename, new Blob([contents], { type: "text/plain;charset=utf-8" }));
}

// JSZip stays behind a dynamic import: a static one puts ~100 KB in the room route's first chunk.
export async function downloadZipFile(
  files: DownloadableFile[],
  filename: string = PROJECT_ZIP_NAME,
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  // INVARIANT: names arrive pre-sanitized (`lib/collab/roomFiles.ts`, `lib/data/deadRooms.ts`);
  // a path separator here would escape the archive root.
  for (const file of files) zip.file(file.filename, file.content);
  clickDownload(filename, await zip.generateAsync({ type: "blob" }));
}
