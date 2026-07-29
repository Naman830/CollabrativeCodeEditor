"use client";

// The Run button's behaviour: POST to `/api/execute`, then publish the result
// into the room's shared execution map so every peer sees the same run.
//
// Execution deliberately does NOT travel over the sync socket — the browser
// posts to the Next route, which proxies to Piston, and only the *result* is
// shared through Yjs. See "Architecture invariant" in CLAUDE.md.

import { useCallback, useRef } from "react";
import type * as Y from "yjs";
import { MAX_CODE_BYTES, TOO_LARGE_MESSAGE, codeByteLength } from "../lib/execution";
import {
  EXECUTION_KEY,
  EXECUTION_MAP_NAME,
  type ExecuteFailure,
  type ExecuteSuccess,
  type ExecutionState,
  type RunAttribution,
} from "../lib/executionState";
import { displayName, type CollabUser } from "../lib/user";

type UseCodeRunnerOptions = {
  /** The live doc from `useCollabRoom`; null while disconnected. */
  docRef: React.RefObject<Y.Doc | null>;
  code: string;
  language: string;
  user: CollabUser | null;
};

export function useCodeRunner({ docRef, code, language, user }: UseCodeRunnerOptions) {
  const runCounterRef = useRef(0);

  return useCallback(async () => {
    const yDoc = docRef.current;
    if (!yDoc || !user) return;

    const executionMap = yDoc.getMap<ExecutionState>(EXECUTION_MAP_NAME);
    // Guards a same-tab double-click. A different peer's concurrent click is
    // handled by the runId check below.
    if (executionMap.get(EXECUTION_KEY)?.status === "running") return;

    runCounterRef.current += 1;
    const runId = `${yDoc.clientID}-${runCounterRef.current}`;
    const startedBy: RunAttribution = { name: displayName(user), color: user.color };
    const startedAt = Date.now();

    // The route enforces this too (it is reachable without the UI); checking
    // here just avoids sending a payload that will be refused. The failure goes
    // into the shared map because the oversized document is shared as well.
    if (codeByteLength(code) > MAX_CODE_BYTES) {
      executionMap.set(EXECUTION_KEY, {
        status: "error",
        runId,
        language,
        startedBy,
        startedAt,
        finishedAt: Date.now(),
        error: TOO_LARGE_MESSAGE,
      });
      return;
    }

    executionMap.set(EXECUTION_KEY, {
      status: "running",
      runId,
      language,
      startedBy,
      startedAt,
    });

    // This run may have lost a race to another peer's, or the effect may have
    // torn down while the fetch was in flight. Either way its result is stale
    // and must not clobber whatever is current.
    const stale = () => {
      if (docRef.current !== yDoc) return true;
      const current = executionMap.get(EXECUTION_KEY);
      return current?.status === "idle" || current?.runId !== runId;
    };

    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code }),
      });

      const data: ExecuteSuccess | ExecuteFailure = await res.json();
      if (stale()) return;

      const finishedAt = Date.now();
      if (!res.ok || !data.success) {
        executionMap.set(EXECUTION_KEY, {
          status: "error",
          runId,
          language,
          startedBy,
          startedAt,
          finishedAt,
          error: !data.success ? data.error : "Execution failed.",
        });
        return;
      }

      executionMap.set(EXECUTION_KEY, {
        status: "success",
        runId,
        language,
        startedBy,
        startedAt,
        finishedAt,
        result: data,
      });
    } catch {
      if (stale()) return;
      executionMap.set(EXECUTION_KEY, {
        status: "error",
        runId,
        language,
        startedBy,
        startedAt,
        finishedAt: Date.now(),
        error: "Could not reach the execution service. Please try again.",
      });
    }
  }, [code, docRef, language, user]);
}
