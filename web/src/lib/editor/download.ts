// Save, in full. It is the mirror image of Run: entirely local — no Yjs write,
// no request, nothing stored anywhere ("saving a file means downloading it to
// the user's device"). v2 keeps it that way; the only thing that ever reaches
// Postgres is the automatic dead-room snapshot, never a Save click.
//
// §10.1 added a second shape — 2+ files zip into `project.zip` — but not a second
// destination. A zip is still built in the browser, still handed to the same
// throwaway `<a download>`, and still stored nowhere.

/** The name §10.1 gives a multi-file room's download. */
export const PROJECT_ZIP_NAME = "project.zip";

/** One file in a zip. Matches `SnapshotFile` in `lib/data/deadRooms.ts` on purpose. */
export type DownloadableFile = {
  filename: string;
  content: string;
};

/** Clicks a throwaway `<a download>` at an object URL, then revokes it. */
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

/** Builds a Blob and clicks a throwaway <a download>, then revokes the URL. */
export function downloadTextFile(filename: string, contents: string): void {
  clickDownload(filename, new Blob([contents], { type: "text/plain;charset=utf-8" }));
}

/**
 * Zips several files and downloads the archive (tasks.md §10.1).
 *
 * JSZip is loaded through a **dynamic** import rather than a static one: it is
 * ~100 KB that only matters at the moment someone clicks Save in a room that has
 * more than one file, and a static import would put it in the room route's first
 * chunk — the same reasoning that keeps `y-websocket` and `y-monaco` behind the
 * dynamic import in `useCollabRoom`.
 *
 * Async, therefore, where `downloadTextFile` is not. Callers must not await it in
 * a handler that needs the click's user activation for anything else; the
 * download itself is fine, because a programmatic `<a download>` click needs no
 * activation.
 */
export async function downloadZipFile(
  files: DownloadableFile[],
  filename: string = PROJECT_ZIP_NAME,
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  // Names arriving here have already been through `sanitizeFileName`
  // (`lib/collab/roomFiles.ts`) or `safeFilename` (`lib/data/deadRooms.ts`), both of which
  // strip path separators — so no entry can escape the archive root.
  for (const file of files) zip.file(file.filename, file.content);
  clickDownload(filename, await zip.generateAsync({ type: "blob" }));
}
