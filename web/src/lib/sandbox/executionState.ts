// INVARIANT: one key in a Y.Map on the code's own Y.Doc, its value replaced
// whole and never per-field, so two concurrent writers converge on one record.

export const EXECUTION_KEY = "state";

export const EXECUTION_MAP_NAME = "execution";

// INVARIANT: outermost of three nested timeouts — must stay above the execute
// route's fetch abort, or a merely-slow run reports as a lost connection.
export const STALE_RUN_MS = 25_000;

export type ExecuteSuccess = {
  success: true;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  compile: { stdout: string; stderr: string; exitCode: number | null } | null;
  // Optional: older records may still sit in a room's execution map.
  notice?: string | null;
};

export type ExecuteFailure = {
  success: false;
  error: string;
};

export type RunAttribution = { name: string; color: string };

// INVARIANT: `stdin`/`filename` are required, not optional — that is what forces
// the compiler to enumerate every write site. `filename` is the room's entry file.
export type ExecutionState =
  | { status: "idle" }
  | {
      status: "running";
      runId: string;
      language: string;
      filename: string;
      stdin: string;
      startedBy: RunAttribution;
      startedAt: number;
    }
  | {
      status: "success";
      runId: string;
      language: string;
      filename: string;
      stdin: string;
      startedBy: RunAttribution;
      startedAt: number;
      finishedAt: number;
      result: ExecuteSuccess;
    }
  | {
      status: "error";
      runId: string;
      language: string;
      filename: string;
      stdin: string;
      startedBy: RunAttribution;
      startedAt: number;
      finishedAt: number;
      error: string;
    };

export const IDLE_EXECUTION: ExecutionState = { status: "idle" };

/** A `notice` counts as failure too: a sandbox-side stop carries no exit code. */
export function isFailedRun(state: ExecutionState): boolean {
  if (state.status === "error") return true;
  if (state.status !== "success") return false;
  return (
    (state.result.compile !== null && state.result.compile.exitCode !== 0) ||
    state.result.exitCode !== 0 ||
    state.result.stderr.length > 0 ||
    Boolean(state.result.notice)
  );
}
