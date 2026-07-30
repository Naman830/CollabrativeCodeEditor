import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  EXECUTION_KEY,
  EXECUTION_MAP_NAME,
  IDLE_EXECUTION,
  STALE_RUN_MS,
  executionMapOf,
  isFailedRun,
  readExecution,
  readExecutionState,
  writeExecution,
  type ExecutionState,
} from "@/lib/sandbox/executionState";

const FALLBACK_COLOR = "#9e9e9e";

function runningRecord(over: Record<string, unknown> = {}) {
  return {
    status: "running",
    runId: "1-1",
    language: "python",
    filename: "main.py",
    stdin: "",
    startedBy: { name: "Ada L.", color: "#ef9a9a" },
    startedAt: 1_000,
    ...over,
  };
}

describe("SEC-05 readExecutionState narrows the peer-written execution map", () => {
  it("SEC-05a a non-object, null or missing record is idle", () => {
    for (const raw of [undefined, null, "", "x", 42, true, []]) {
      // An array is an object, so it falls through to the status switch and defaults to idle.
      expect(readExecutionState(raw).status).toBe("idle");
    }
  });

  it("SEC-05b an unknown status is idle rather than rendered", () => {
    expect(readExecutionState({ status: "pending" }).status).toBe("idle");
    expect(readExecutionState({ status: 5 }).status).toBe("idle");
  });

  // The room-wide DoS: OutputPanel destructures state.startedBy.color and state.result.
  it("SEC-05c a success record with no startedBy and no result is fully populated", () => {
    const state = readExecutionState({ status: "success" });
    expect(state.status).toBe("success");
    if (state.status !== "success") throw new Error("unreachable");

    expect(state.startedBy).toEqual({ name: "Anonymous", color: FALLBACK_COLOR });
    expect(state.result).toEqual({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: null,
      compile: null,
      notice: null,
    });
    // Every field OutputPanel reads must be present, or the room renders error.tsx for everyone.
    expect(() => isFailedRun(state)).not.toThrow();
    expect(state.result.compile).toBeNull();
  });

  it("SEC-05d a running record with no startedAt gets 0, so the watchdog heals it at once", () => {
    const state = readExecutionState({ status: "running" });
    if (state.status !== "running") throw new Error("unreachable");
    // 0, never Date.now(): NaN or a future value would disable Run room-wide forever.
    expect(state.startedAt).toBe(0);
    expect(Date.now() - state.startedAt).toBeGreaterThan(STALE_RUN_MS);

    for (const bad of [undefined, null, "1000", NaN, Infinity, {}]) {
      const s = readExecutionState(runningRecord({ startedAt: bad }));
      if (s.status !== "running") throw new Error("unreachable");
      expect(s.startedAt).toBe(0);
    }
  });

  it("SEC-05e a colour failing HEX_COLOR falls back to grey, not into an inline style", () => {
    for (const hostile of [
      "red } body { display: none } .x {",
      "</style><script>alert(1)</script>",
      "#FFF",
      "#gggggg",
      "rgb(1,2,3)",
      "#ffffff ",
      42,
      null,
    ]) {
      const state = readExecutionState(runningRecord({ startedBy: { name: "x", color: hostile } }));
      if (state.status !== "running") throw new Error("unreachable");
      expect(state.startedBy.color).toBe(FALLBACK_COLOR);
    }
    // A genuine hex still survives, in both cases.
    expect(
      readExecutionState(runningRecord({ startedBy: { name: "x", color: "#AbCdEf" } })).status
    ).toBe("running");
  });

  it("SEC-05f the attribution name is re-sanitized and capped", () => {
    const state = readExecutionState(
      runningRecord({ startedBy: { name: "a".repeat(200), color: "#ef9a9a" } })
    );
    if (state.status !== "running") throw new Error("unreachable");
    expect([...state.startedBy.name].length).toBe(24);

    // Control characters collapse; an empty result becomes the shared fallback name.
    expect(
      readExecutionState(runningRecord({ startedBy: { name: "   ", color: "#ef9a9a" } })).status
    ).toBe("running");
    const blank = readExecutionState(runningRecord({ startedBy: { name: "\u0000\u0001" } }));
    if (blank.status !== "running") throw new Error("unreachable");
    expect(blank.startedBy.name).toBe("Anonymous");
  });

  it("SEC-05g a forged language outside the allowlist becomes the default", () => {
    for (const bad of ["rust", "Python", "", null, 42, "__proto__"]) {
      const state = readExecutionState(runningRecord({ language: bad }));
      if (state.status !== "running") throw new Error("unreachable");
      expect(state.language).toBe("javascript");
    }
    expect(readExecutionState(runningRecord({ language: "cpp" })).status).toBe("running");
  });

  it("SEC-05h a filename loses path separators; absent stays empty for pre-10.1 records", () => {
    const traversal = readExecutionState(runningRecord({ filename: "../../etc/passwd" }));
    if (traversal.status !== "running") throw new Error("unreachable");
    expect(traversal.filename).toBe("....etcpasswd");
    expect(traversal.filename).not.toContain("/");

    // `undefined` is legitimate: records written before §10.1 carry no filename.
    const legacy = readExecutionState(runningRecord({ filename: undefined }));
    if (legacy.status !== "running") throw new Error("unreachable");
    expect(legacy.filename).toBe("");
  });

  it("SEC-05i unbounded output is capped without leaving a halved surrogate pair", () => {
    const huge = "a".repeat(200_000);
    const state = readExecutionState({ ...runningRecord(), status: "success", result: { stdout: huge } });
    if (state.status !== "success") throw new Error("unreachable");
    expect(state.result.stdout.length).toBe(64 * 1024);

    // `error` has its own tighter 4 KB cap. Straddling it with a surrogate pair must drop the
    // orphan rather than emit a lone surrogate, which is what would reach the DOM.
    const emoji = "A".repeat(4 * 1024 - 1) + "😀";
    const cut = readExecutionState({ ...runningRecord(), status: "error", error: emoji });
    if (cut.status !== "error") throw new Error("unreachable");
    expect(/[\uD800-\uDBFF]$/.test(cut.error)).toBe(false);
    expect(cut.error.length).toBe(4 * 1024 - 1);

    // A pair wholly inside the cap survives intact.
    const kept = readExecutionState({ ...runningRecord(), status: "error", error: "ok 😀" });
    if (kept.status !== "error") throw new Error("unreachable");
    expect(kept.error).toBe("ok 😀");
  });

  it("SEC-05j an error record with no message still says something", () => {
    const state = readExecutionState({ ...runningRecord(), status: "error" });
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.error).toBe("The run failed without a message.");
  });

  it("SEC-05k a well-formed record round-trips unchanged", () => {
    const record: ExecutionState = {
      status: "success",
      runId: "7-3",
      language: "python",
      filename: "main.py",
      stdin: "42\n",
      startedBy: { name: "Ada L.", color: "#ef9a9a" },
      startedAt: 1_000,
      finishedAt: 2_000,
      result: {
        success: true,
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        compile: null,
        notice: null,
      },
    };
    expect(readExecutionState(record)).toEqual(record);
  });
});

describe("SEC-06 readExecution/writeExecution are the only map accessors", () => {
  it("SEC-06a a hostile peer write is neutralised on read through the real Y.Map", () => {
    const doc = new Y.Doc();
    const map = executionMapOf(doc);

    // Exactly what a raw Yjs client in the room can do today.
    doc.getMap(EXECUTION_MAP_NAME).set(EXECUTION_KEY, { status: "success" } as never);

    const state = readExecution(map);
    expect(state.status).toBe("success");
    if (state.status !== "success") throw new Error("unreachable");
    expect(state.startedBy.color).toBe(FALLBACK_COLOR);
    expect(state.result.stdout).toBe("");
  });

  it("SEC-06b an empty map reads as idle", () => {
    const doc = new Y.Doc();
    expect(readExecution(executionMapOf(doc))).toEqual(IDLE_EXECUTION);
  });

  it("SEC-06c writeExecution round-trips through readExecution", () => {
    const doc = new Y.Doc();
    const map = executionMapOf(doc);
    const record: ExecutionState = {
      status: "running",
      runId: "1-1",
      language: "java",
      filename: "Main.java",
      stdin: "",
      startedBy: { name: "Ada L.", color: "#ef9a9a" },
      startedAt: 5_000,
    };
    writeExecution(map, record);
    expect(readExecution(map)).toEqual(record);
  });

  it("SEC-06d both peers converge on one whole record, never a field mix", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const mapA = executionMapOf(a);
    const mapB = executionMapOf(b);

    writeExecution(mapA, { status: "running", runId: "a-1", language: "python", filename: "main.py", stdin: "", startedBy: { name: "A", color: "#ef9a9a" }, startedAt: 1 });
    writeExecution(mapB, { status: "running", runId: "b-1", language: "cpp", filename: "main.cpp", stdin: "", startedBy: { name: "B", color: "#90caf9" }, startedAt: 2 });

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const left = readExecution(mapA);
    const right = readExecution(mapB);
    expect(left).toEqual(right);
    if (left.status !== "running") throw new Error("unreachable");
    // Whichever won, its fields are internally consistent - no cross-record blend.
    const pairs = { "a-1": "main.py", "b-1": "main.cpp" } as Record<string, string>;
    expect(left.filename).toBe(pairs[left.runId]);
  });
});

describe("EC-12 isFailedRun's truth table", () => {
  const base = {
    status: "success" as const,
    runId: "1-1",
    language: "python",
    filename: "main.py",
    stdin: "",
    startedBy: { name: "A", color: "#ef9a9a" },
    startedAt: 1,
    finishedAt: 2,
  };
  const result = (over: Partial<ExecuteResultShape>) => ({
    success: true as const,
    stdout: "",
    stderr: "",
    exitCode: 0,
    compile: null,
    notice: null,
    ...over,
  });
  type ExecuteResultShape = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    compile: { stdout: string; stderr: string; exitCode: number | null } | null;
    notice: string | null;
  };

  it("EC-12a a clean run is not a failure", () => {
    expect(isFailedRun({ ...base, result: result({}) })).toBe(false);
  });

  it("EC-12b each failure signal on its own is enough", () => {
    expect(isFailedRun({ ...base, result: result({ exitCode: 1 }) })).toBe(true);
    expect(isFailedRun({ ...base, result: result({ stderr: "warn" }) })).toBe(true);
    expect(isFailedRun({ ...base, result: result({ notice: "x" }) })).toBe(true);
    expect(
      isFailedRun({ ...base, result: result({ compile: { stdout: "", stderr: "", exitCode: 1 } }) })
    ).toBe(true);
  });

  it("EC-12c an empty notice and a zero compile exit are not failures", () => {
    expect(isFailedRun({ ...base, result: result({ notice: "" }) })).toBe(false);
    expect(
      isFailedRun({ ...base, result: result({ compile: { stdout: "", stderr: "", exitCode: 0 } }) })
    ).toBe(false);
  });

  it("EC-12d idle and running are never failures; error always is", () => {
    expect(isFailedRun(IDLE_EXECUTION)).toBe(false);
    expect(
      isFailedRun({ status: "running", runId: "1", language: "python", filename: "main.py", stdin: "", startedBy: { name: "A", color: "#ef9a9a" }, startedAt: 1 })
    ).toBe(false);
    expect(isFailedRun({ ...base, status: "error", error: "boom" })).toBe(true);
  });
});

describe("DRIFT-01 shared-map identifiers are load-bearing", () => {
  it("DRIFT-01a renaming either key silently splits the room's shared state", () => {
    expect(EXECUTION_MAP_NAME).toBe("execution");
    expect(EXECUTION_KEY).toBe("state");
  });

  it("DRIFT-01b STALE_RUN_MS stays outside the route's fetch abort (18s)", () => {
    expect(STALE_RUN_MS).toBe(25_000);
    expect(STALE_RUN_MS).toBeGreaterThan(18_000);
  });
});
