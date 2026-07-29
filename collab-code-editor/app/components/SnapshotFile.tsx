// A dead room's code, read-only.
//
// Deliberately a `<pre>` and not Monaco. Three reasons, in order of weight:
//
//  1. tasks.md §7.4's last bullet asks for it to be *visually clear* the room is
//     closed. An editor is the one widget on this site that means "you can type
//     here"; rendering one and switching `readOnly` on says the opposite of what
//     the page is for.
//  2. There is nothing to highlight. `dead_rooms.language` is null on every row
//     until §10.1 moves the language selector to room creation, so Monaco would
//     load ~5 MB to render plaintext.
//  3. `lib/monacoLoader.ts` imports `monaco-editor` at module scope, which
//     touches `window`. That import chain is why `/room/[roomId]` returns HTTP
//     500 from the server on every request (see CLAUDE.md). Keeping it out of
//     this route's graph is what lets /profile actually server-render.

import { isTruncated, type SnapshotFile as SnapshotFileData } from "../lib/deadRooms";
import SnapshotActions from "./SnapshotActions";

/** Human-readable byte count. The cap it approaches is 256 KB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SnapshotFile({ file }: { file: SnapshotFileData }) {
  const lineCount = file.content.length === 0 ? 0 : file.content.split("\n").length;
  const bytes = new TextEncoder().encode(file.content).length;
  const truncated = isTruncated(file.content);

  // One string, not one element per line: a snapshot can reach 256 KB, which is
  // ~8000 lines, and a gutter of 8000 spans is 8000 DOM nodes to render numbers
  // nobody selects.
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");

  return (
    <section className="overflow-hidden rounded-2xl border border-edge bg-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge px-4 py-2.5">
        <span className="font-mono text-sm text-fg">{file.filename}</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-fg-muted">
          {lineCount} {lineCount === 1 ? "line" : "lines"} · {formatBytes(bytes)}
        </span>
        <div className="ml-auto">
          <SnapshotActions filename={file.filename} content={file.content} />
        </div>
      </div>

      {truncated && (
        <p className="border-b border-edge bg-warning-soft px-4 py-2 text-xs text-warning">
          This room grew past the 256 KB snapshot cap, so the end of the file was not saved.
          The marker at the bottom is where it was cut.
        </p>
      )}

      {file.content.length === 0 ? (
        <p className="px-4 py-6 text-sm text-fg-muted">This room was empty when it closed.</p>
      ) : (
        // The container scrolls both ways; the gutter is `sticky left-0` so it
        // stays put while the code scrolls sideways, and scrolls away with the
        // code vertically. `select-none` keeps line numbers out of a selection
        // dragged across the code.
        <div className="max-h-[70vh] overflow-auto bg-code">
          <div className="flex min-w-max">
            <pre
              aria-hidden
              className="sticky left-0 select-none border-r border-edge bg-code px-3 py-3 text-right font-mono text-sm leading-relaxed text-fg-subtle"
            >
              {gutter}
            </pre>
            <pre className="px-4 py-3 font-mono text-sm leading-relaxed text-fg">
              {file.content}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
