// INVARIANT: one key in a Y.Map on the code's own Y.Doc, its value replaced
// whole and never per-field, so two concurrent writers converge on one record.

import type * as Y from "yjs";
import { FALLBACK_COLOR, FALLBACK_NAME, HEX_COLOR } from "@/lib/collab/awareness";
import { sanitizeFileName } from "@/lib/collab/roomFiles";
import { sanitizeName } from "@/lib/collab/user";
import { DEFAULT_LANGUAGE, isLanguage } from "@/lib/editor/languages";

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

export type ExecutionMap = Y.Map<ExecutionState>;

/** Peer-supplied text reaches a `<pre>`; a real run's whole payload is capped at 64 KB upstream. */
const MAX_OUTPUT_CHARS = 64 * 1024;

export function executionMapOf(yDoc: Y.Doc): ExecutionMap {
  return yDoc.getMap<ExecutionState>(EXECUTION_MAP_NAME);
}

/** INVARIANT: the only reader of EXECUTION_KEY — nothing may call `map.get()` itself. */
export function readExecution(map: ExecutionMap): ExecutionState {
  return readExecutionState(map.get(EXECUTION_KEY));
}

/** INVARIANT: the only writer, and typed, so the compiler still enumerates every write site. */
export function writeExecution(map: ExecutionMap, next: ExecutionState): void {
  map.set(EXECUTION_KEY, next);
}

function text(value: unknown, max = MAX_OUTPUT_CHARS): string {
  if (typeof value !== "string") return "";
  const cut = value.length > max ? value.slice(0, max) : value;
  // A UTF-16 cut can halve a surrogate pair; drop the orphan rather than render U+FFFD.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function exitCodeOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// As readPeers: the name is re-sanitized and a colour failing HEX_COLOR becomes grey, because
// this colour is written straight into an inline `style` in OutputPanel.
function attribution(value: unknown): RunAttribution {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? sanitizeName(raw.name) : "";
  return {
    name: name || FALLBACK_NAME,
    color: typeof raw.color === "string" && HEX_COLOR.test(raw.color) ? raw.color : FALLBACK_COLOR,
  };
}

function compileStage(value: unknown): ExecuteSuccess["compile"] {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return { stdout: text(raw.stdout), stderr: text(raw.stderr), exitCode: exitCodeOf(raw.exitCode) };
}

// Synthesized rather than rejected: a `success` record missing its `result` still describes a
// run that happened, and an empty one renders as "(no output)".
function successResult(value: unknown): ExecuteSuccess {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    success: true,
    stdout: text(raw.stdout),
    stderr: text(raw.stderr),
    exitCode: exitCodeOf(raw.exitCode),
    compile: compileStage(raw.compile),
    notice: (typeof raw.notice === "string" ? text(raw.notice, 512) : "") || null,
  };
}

/**
 * INVARIANT: the `execution` map is peer-supplied and this is its only sanitizing boundary — the
 * same family as `readPeers()` and `readRoomFiles()`. Total: never throws, and always returns a
 * fully-populated state, which is what lets OutputPanel destructure every field it reads.
 */
export function readExecutionState(raw: unknown): ExecutionState {
  if (!raw || typeof raw !== "object") return IDLE_EXECUTION;
  const record = raw as Record<string, unknown>;

  const shared = {
    runId: text(record.runId, 128),
    // A run's language can only come from a room whose language the sync server already
    // narrowed through the same allowlist, so a value outside it is by definition forged.
    language: isLanguage(record.language) ? record.language : DEFAULT_LANGUAGE,
    // "" stays legitimate: `filename` is absent on records written before §10.1.
    filename: record.filename === undefined ? "" : sanitizeFileName(record.filename),
    stdin: text(record.stdin),
    startedBy: attribution(record.startedBy),
    // INVARIANT: 0, never Date.now() — a missing startedAt must make the stale-run watchdog
    // fire immediately, or a forged "running" record disables Run for the whole room forever.
    startedAt: finite(record.startedAt, 0),
  };

  switch (record.status) {
    case "running":
      return { status: "running", ...shared };
    case "success":
      return {
        status: "success",
        ...shared,
        finishedAt: finite(record.finishedAt, 0),
        result: successResult(record.result),
      };
    case "error":
      return {
        status: "error",
        ...shared,
        finishedAt: finite(record.finishedAt, 0),
        error: text(record.error, 4 * 1024) || "The run failed without a message.",
      };
    default:
      return IDLE_EXECUTION;
  }
}

/**
 * A `notice` counts as failure too: a sandbox-side stop carries no exit code.
 * INVARIANT: its argument is post-`readExecutionState`, so every field below is present.
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
