"use client";

import type { KeyboardEvent } from "react";
import { IconButton, PanelActions, PanelStrip, PanelTab } from "./PanelStrip";
import { ChevronDownIcon, SplitIcon, TerminalIcon } from "@/components/ui/icons";
import type { Orientation } from "@/hooks/useRoomLayout";
import { MAX_CODE_BYTES, codeByteLength } from "@/lib/sandbox/execution";
import { isFailedRun, type ExecutionState } from "@/lib/sandbox/executionState";
import { languageLabel } from "@/lib/editor/languages";
import { cn, focusRing } from "@/lib/ui";

/** Past this, the field starts reporting its size against the shared budget. */
const STDIN_HINT_BYTES = 4 * 1024;

/** INVARIANT: render the shared run record, never local state — except the local stdin draft. */
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
  /** The local draft, never the shared record's. */
  stdin: string;
  stdinOpen: boolean;
  onStdinChange: (value: string) => void;
  onToggleStdin: () => void;
  /** Run/Save from inside the field, since Monaco's bindings can't reach it. */
  onStdinKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const failed = isFailedRun(state);
  const stdinBytes = codeByteLength(stdin);

  const dot =
    state.status === "idle"
      ? null
      : failed
        ? "bg-danger"
        : state.status === "running"
          ? "bg-warning"
          : "bg-success";

  return (
    // `min-h-0` lets this shrink below its content when the split is dragged small.
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-panel">
      <PanelStrip>
        <PanelTab icon={<TerminalIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />}>
          <span className="truncate">Output</span>
          {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
        </PanelTab>

        <PanelActions>
          {state.status !== "idle" && !collapsed && (
            <span className="hidden min-w-0 items-center gap-1.5 truncate text-xs text-fg-subtle sm:flex">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: state.startedBy.color }}
              />
              {/* The run's own entry file, not the viewer's tab; absent on older records. */}
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

      {/* `shrink-0` so the scrolling body below owns the leftover height. */}
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
            {/* Closed-with-content is otherwise invisible. */}
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

      {/* `min-h-0`, not just `flex-1`: without it `overflow-auto` never engages.

          INVARIANT: this is a live region. Running code is the app's headline action and its
          result arrives asynchronously — without `aria-live` a screen-reader user pressed Run and
          was told nothing, ever. `aria-busy` covers the gap while it runs.

          `polite`, not `assertive`: the result must not interrupt someone mid-sentence, and it is
          not an emergency. `aria-atomic={false}` so a long stdout is not re-read in full. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic={false}
        aria-busy={state.status === "running"}
        aria-label="Run output"
        className={cn(
          "min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-sm transition-colors",
          failed ? "bg-code-failed" : "bg-code",
        )}
      >
        {/* The run's own stdin from the shared record, not the draft above; absent on older records. */}
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
            {/* Last: it explains why the output above stops where it does. */}
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
