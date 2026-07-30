// The shape of a run, as every peer in the room sees it.
//
// This lives in a `Y.Map` on the *same* `Y.Doc` as the code, under a single key
// (`EXECUTION_KEY`) whose value is replaced whole — never per-field — so two
// concurrent writers converge on one complete record rather than a mix of two
// runs. See "Shared code execution" in CLAUDE.md.
//
// Free of React and browser APIs: the types are shared by the collab hook, the
// runner, and the output panel.

/** The one key in the execution `Y.Map`. */
export const EXECUTION_KEY = "state";

/** The `Y.Map` name on the shared doc. */
export const EXECUTION_MAP_NAME = "execution";

/**
 * How long the room waits before treating a run as abandoned. If the peer who
 * clicked Run disappears mid-flight, nothing else ever writes a result and every
 * Run button stays disabled. This is the outermost of three nested timeouts —
 * sandbox (10s compile + 5s run), then the route's 18s fetch abort, then this —
 * so lowering it would report merely-slow runs as a lost connection.
 */
export const STALE_RUN_MS = 25_000;

export type ExecuteSuccess = {
  success: true;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  compile: { stdout: string; stderr: string; exitCode: number | null } | null;
  // Set when the sandbox stopped the program itself (output cap, timeout).
  // Optional because older records may still sit in a room's execution map.
  notice?: string | null;
};

export type ExecuteFailure = {
  success: false;
  error: string;
};

export type RunAttribution = { name: string; color: string };

// Lives in a Y.Map under one key, replaced whole, so every peer sees the same
// run. `runId` lets a run that lost a race recognise its own result as stale.
//
// `stdin` (tasks.md §10.4) rides here rather than in local component state for
// the same reason `language` does: the run is broadcast to the whole room, so a
// peer watching the output has to be able to see what was fed in or the output
// is unexplainable. It is part of the *run*, not part of the editor — the box
// people type into stays local, and this is only the value a run actually used.
//
// `filename` (tasks.md §10.1) is there for exactly the same reason. Run always
// executes the room's *entry* file, which is not necessarily the tab the person
// watching has open — so without it the output belongs to no visible file and a
// peer cannot tell whether they are looking at the result of the code in front
// of them. Sourced from the shared file list, never from the viewer's own tab.
//
// Both are required rather than optional, unlike `notice`: a missing `notice` is
// the common case, while a missing `stdin` or `filename` is only possible across
// a mixed-bundle window. Making them required is what forces the compiler to
// enumerate every site that writes a record (four in `useCodeRunner`, one
// watchdog in `useCollabRoom`); the output panel still guards on them before
// rendering.
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

/**
 * Whether a *completed* run should read as a failure. A non-zero exit, anything
 * on stderr, or a failed compile all count — and so does a `notice`, because a
 * sandbox-side stop (output cap, OOM) has no exit code and would otherwise look
 * like a clean run.
 */
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
