"use client";

import { IconButton, PanelActions, PanelStrip, PanelTab } from "./PanelStrip";
import { ChevronDownIcon, SplitIcon, TerminalIcon } from "./icons";
import type { Orientation } from "../hooks/useRoomLayout";
import { isFailedRun, type ExecutionState } from "../lib/executionState";
import { languageLabel } from "../lib/languages";
import { cn } from "../lib/ui";

/**
 * The result of the room's current run. Everything here comes from the shared
 * `ExecutionState`, never from local component state — in particular the caption
 * shows the run's *own* language, not the viewer's dropdown selection, since two
 * peers can have different languages selected while watching one run.
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
}: {
  state: ExecutionState;
  collapsed: boolean;
  orientation: Orientation;
  /** False on phones, where the stack is forced. */
  canToggleOrientation: boolean;
  onToggleCollapsed: () => void;
  onToggleOrientation: () => void;
}) {
  const failed = isFailedRun(state);

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
              <span className="truncate">
                Run by {state.startedBy.name} · {languageLabel(state.language)}
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
