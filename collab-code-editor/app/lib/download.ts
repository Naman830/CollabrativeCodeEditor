// Save, in full. It is the mirror image of Run: entirely local — no Yjs write,
// no request, nothing stored anywhere ("saving a file means downloading it to
// the user's device"). v2 keeps it that way; the only thing that ever reaches
// Postgres is the automatic dead-room snapshot, never a Save click.

/** Builds a Blob and clicks a throwaway <a download>, then revokes the URL. */
export function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
