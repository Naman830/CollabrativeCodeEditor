"use client";

import { isFailedRun, type ExecutionState } from "../lib/executionState";
import { languageLabel } from "../lib/languages";

/**
 * The result of the room's current run. Everything here comes from the shared
 * `ExecutionState`, never from local component state — in particular the
 * caption shows the run's *own* language, not the viewer's dropdown selection,
 * since two peers can have different languages selected while watching one run.
 */
export default function OutputPanel({ state }: { state: ExecutionState }) {
  const failed = isFailedRun(state);

  return (
    <div className="flex h-56 flex-col bg-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge px-4 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Output
        </span>

        {state.status !== "idle" && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: state.startedBy.color }}
            />
            Run by {state.startedBy.name} · {languageLabel(state.language)}
            {state.status === "success" && (
              <> · Exit code: {state.result.exitCode ?? "—"}</>
            )}
          </span>
        )}
      </div>

      <div
        className={`flex-1 overflow-auto px-4 py-3 font-mono text-sm transition-colors ${
          failed ? "bg-[#1f1414]" : "bg-[#101010]"
        }`}
      >
        {state.status === "idle" && (
          <pre className="whitespace-pre-wrap text-zinc-600">
            Output will appear here…
          </pre>
        )}

        {state.status === "running" && (
          <pre className="whitespace-pre-wrap text-zinc-500">Running your code…</pre>
        )}

        {state.status === "error" && (
          <pre className="whitespace-pre-wrap text-red-400">{state.error}</pre>
        )}

        {state.status === "success" && (
          <>
            {state.result.compile && state.result.compile.exitCode !== 0 && (
              <pre className="whitespace-pre-wrap text-red-400">
                {state.result.compile.stderr}
              </pre>
            )}
            {state.result.stdout && (
              <pre className="whitespace-pre-wrap text-zinc-300">
                {state.result.stdout}
              </pre>
            )}
            {state.result.stderr && (
              <pre className="whitespace-pre-wrap text-red-400">
                {state.result.stderr}
              </pre>
            )}
            {/* Last, because it explains why the output above stops where it
                does — the program was killed mid-write, not finished. */}
            {state.result.notice && (
              <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-amber-300">
                {state.result.notice}
              </pre>
            )}
            {!state.result.stdout && !state.result.stderr && !state.result.notice && (
              <pre className="whitespace-pre-wrap text-zinc-600">(no output)</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
