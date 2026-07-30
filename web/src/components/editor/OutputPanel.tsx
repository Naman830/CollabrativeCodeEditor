"use client";

import type { KeyboardEvent } from "react";
import { IconButton, PanelActions, PanelStrip, PanelTab } from "./PanelStrip";
import { ChevronDownIcon, SplitIcon, TerminalIcon } from "@/components/ui/icons";
import type { Orientation } from "@/hooks/useRoomLayout";
import { MAX_CODE_BYTES, codeByteLength } from "@/lib/execution";
import { isFailedRun, type ExecutionState } from "@/lib/executionState";
import { languageLabel } from "@/lib/languages";
import { cn, focusRing } from "@/lib/ui";

/** Past this, the field starts reporting its size against the shared budget. */
const STDIN_HINT_BYTES = 4 * 1024;

/**
 * The result of the room's current run. Everything here comes from the shared
 * `ExecutionState`, never from local component state — in particular the caption
 * shows the run's *own* language, not the viewer's dropdown selection, since two
 * peers can have different languages selected while watching one run.
 *
 * The one exception is the stdin *draft* box (tasks.md §10.4), which is
 * deliberately local: the value a run actually used travels on the shared
 * record and is echoed read-only above the output, so a peer can explain what
 * they are looking at without anyone's typing being overwritten by a remote run.
 *
 * The panel no longer sets its own height: it fills whatever the resizable
 * `Panel` around it gives it. `h-56` used to be hardcoded here.
 */
export default function OutputPanel({
  state,
  collapsed,
  orientation,
  canToggleOrientation,
  onToggleCollapsed,
  onToggleOrientation,
  stdin,
  stdinOpen,
  onStdinChange,
  onToggleStdin,
  onStdinKeyDown,
}: {
  state: ExecutionState;
  collapsed: boolean;
  orientation: Orientation;
  /** False on phones, where the stack is forced. */
  canToggleOrientation: boolean;
  onToggleCollapsed: () => void;
  onToggleOrientation: () => void;
  /** The local draft. Never the shared record's — see the note above. */
  stdin: string;
  stdinOpen: boolean;
  onStdinChange: (value: string) => void;
  onToggleStdin: () => void;
  /** Run/Save from inside the field, since Monaco's bindings can't reach it. */
  onStdinKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const failed = isFailedRun(state);
  const stdinBytes = codeByteLength(stdin);

  // A dot on the tab, so a collapsed panel still reports how the last run went.
  const dot =
    state.status === "idle"
      ? null
      : failed
        ? "bg-danger"
        : state.status === "running"
          ? "bg-warning"
          : "bg-success";

  return (
    // `min-h-0` on the root is what lets this shrink below its content when the
    // split is dragged small; without it the strip plus the body size to content
    // and overflow the panel.
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-panel">
      <PanelStrip>
        <PanelTab icon={<TerminalIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />}>
          <span className="truncate">Output</span>
          {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
        </PanelTab>

        <PanelActions>
          {state.status !== "idle" && !collapsed && (
            // Hidden below `sm`, where the two icon buttons win the space. The
            // same facts are repeated in the body, so nothing is lost.
            <span className="hidden min-w-0 items-center gap-1.5 truncate text-xs text-fg-subtle sm:flex">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: state.startedBy.color }}
              />
              {/* The run's own file and language, never the viewer's open tab:
                  Run executes the room's entry file (§10.1), so the person
                  watching may well be looking at something else entirely.
                  `filename` is guarded because a record written by an older
                  bundle carries none. */}
              <span className="truncate">
                Run by {state.startedBy.name}
                {state.filename && <> · {state.filename}</>} ·{" "}
                {languageLabel(state.language)}
                {state.status === "success" && <> · Exit {state.result.exitCode ?? "—"}</>}
              </span>
            </span>
          )}

          {canToggleOrientation && (
            <IconButton
              label={
                orientation === "horizontal"
                  ? "Stack the output below the editor"
                  : "Move the output beside the editor"
              }
              onClick={onToggleOrientation}
            >
              <SplitIcon
                className={cn("h-3.5 w-3.5", orientation === "vertical" && "rotate-90")}
              />
            </IconButton>
          )}

          <IconButton
            label={collapsed ? "Expand the output" : "Collapse the output"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            <ChevronDownIcon
              className={cn("panel-chevron h-3.5 w-3.5 transition-transform", !collapsed && "rotate-180")}
            />
          </IconButton>
        </PanelActions>
      </PanelStrip>

      {/* The stdin draft box (§10.4), above the output and `shrink-0` so the
          body below keeps `min-h-0 flex-1 overflow-auto` and owns the leftover
          height. Hidden entirely when the panel is collapsed, where the strip
          above is the only thing left. */}
      {!collapsed && (
        <div className="shrink-0 border-b border-edge bg-panel">
          <button
            type="button"
            onClick={onToggleStdin}
            aria-expanded={stdinOpen}
            aria-controls="stdin-field"
            className={cn(
              "flex w-full items-center gap-1.5 px-3 py-1.5 text-left",
              "text-[11px] font-medium uppercase tracking-wider text-fg-subtle",
              "transition-colors hover:text-fg",
              focusRing,
            )}
          >
            <ChevronDownIcon
              className={cn("h-3 w-3 shrink-0 transition-transform", !stdinOpen && "-rotate-90")}
            />
            Input (stdin)
            {/* Closed with content is otherwise invisible, which makes a run
                that consumed input look like it invented it. */}
            {!stdinOpen && stdin.length > 0 && (
              <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-fg-muted">
                {stdin.split("\n").length} line{stdin.split("\n").length === 1 ? "" : "s"}
              </span>
            )}
          </button>

          {stdinOpen && (
            <div id="stdin-field" className="px-3 pb-2">
              <textarea
                value={stdin}
                onChange={(event) => onStdinChange(event.target.value)}
                onKeyDown={onStdinKeyDown}
                rows={3}
                spellCheck={false}
                aria-label="Standard input for the next run"
                placeholder="Text passed to your program's standard input…"
                className={cn(
                  focusRing,
                  "w-full resize-none rounded-lg border border-edge bg-raised px-2.5 py-1.5",
                  "font-mono text-xs text-fg transition-colors",
                  "placeholder:text-fg-subtle focus:border-accent",
                )}
              />
              {stdinBytes > STDIN_HINT_BYTES && (
                <p className="mt-1 text-[10px] text-fg-subtle">
                  {(stdinBytes / 1024).toFixed(1)} KB — counts toward the{" "}
                  {Math.floor(MAX_CODE_BYTES / 1024)} KB run limit shared with your code.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* `min-h-0` and not merely `flex-1`: `flex-1` leaves `min-height: auto`,
          i.e. the content's own height, so a long stack trace would push the
          panel open instead of scrolling inside it and `overflow-auto` would
          never engage. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-sm transition-colors",
          failed ? "bg-code-failed" : "bg-code",
        )}
      >
        {/* Read from the shared record, never from the local draft above — the
            same rule the caption follows for `language`. This is what lets a
            peer who typed nothing understand why the output says what it says.
            Guarded rather than assumed: a record written by an older bundle
            carries no `stdin` at all. */}
        {state.status !== "idle" && state.stdin && (
          <div className="mb-2 border-l-2 border-edge-strong pl-2.5">
            <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
              Input used for this run
            </p>
            <pre className="whitespace-pre-wrap text-fg-muted">{state.stdin}</pre>
          </div>
        )}

        {state.status === "idle" && (
          <pre className="whitespace-pre-wrap text-fg-subtle">Output will appear here…</pre>
        )}

        {state.status === "running" && (
          <pre className="whitespace-pre-wrap text-fg-muted">Running your code…</pre>
        )}

        {state.status === "error" && (
          <pre className="whitespace-pre-wrap text-danger">{state.error}</pre>
        )}

        {state.status === "success" && (
          <>
            {state.result.compile && state.result.compile.exitCode !== 0 && (
              <pre className="whitespace-pre-wrap text-danger">{state.result.compile.stderr}</pre>
            )}
            {state.result.stdout && (
              <pre className="whitespace-pre-wrap text-fg">{state.result.stdout}</pre>
            )}
            {state.result.stderr && (
              <pre className="whitespace-pre-wrap text-danger">{state.result.stderr}</pre>
            )}
            {/* Last, because it explains why the output above stops where it
                does — the program was killed mid-write, not finished. */}
            {state.result.notice && (
              <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-warning">
                {state.result.notice}
              </pre>
            )}
            {!state.result.stdout && !state.result.stderr && !state.result.notice && (
              <pre className="whitespace-pre-wrap text-fg-subtle">(no output)</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
