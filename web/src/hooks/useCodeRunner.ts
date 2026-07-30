"use client";

// INVARIANT: execution never travels over the sync socket — the browser POSTs to
// /api/execute and only the *result* is shared through Yjs.

import { useCallback, useRef } from "react";
import type * as Y from "yjs";
import { payloadTooLarge } from "@/lib/sandbox/execution";
import {
  EXECUTION_KEY,
  EXECUTION_MAP_NAME,
  type ExecuteFailure,
  type ExecuteSuccess,
  type ExecutionState,
  type RunAttribution,
} from "@/lib/sandbox/executionState";
import { fileTextName, type RoomFile } from "@/lib/collab/roomFiles";
import { displayName, type CollabUser } from "@/lib/collab/user";

type UseCodeRunnerOptions = {
  docRef: React.RefObject<Y.Doc | null>;
  /** Run executes the entry file, not necessarily the tab this client has open. */
  entryFile: RoomFile | null;
  language: string;
  stdin: string;
  user: CollabUser | null;
};

export function useCodeRunner({
  docRef,
  entryFile,
  language,
  stdin,
  user,
}: UseCodeRunnerOptions) {
  const runCounterRef = useRef(0);

  return useCallback(async () => {
    const yDoc = docRef.current;
    if (!yDoc || !user || !entryFile) return;

    const executionMap = yDoc.getMap<ExecutionState>(EXECUTION_MAP_NAME);
    // Guards a same-tab double-click; a peer's concurrent click is caught by runId.
    if (executionMap.get(EXECUTION_KEY)?.status === "running") return;

    // INVARIANT: read the entry file's Y.Text, never Monaco — it may have no model here.
    const code = yDoc.getText(fileTextName(entryFile.id)).toString();
    const filename = entryFile.name;

    runCounterRef.current += 1;
    const runId = `${yDoc.clientID}-${runCounterRef.current}`;
    const startedBy: RunAttribution = { name: displayName(user), color: user.color };
    const startedAt = Date.now();

    if (code.length === 0) {
      executionMap.set(EXECUTION_KEY, {
        status: "error",
        runId,
        language,
        filename,
        stdin,
        startedBy,
        startedAt,
        finishedAt: Date.now(),
        error: `Nothing to run — the entry file (${filename}) is empty.`,
      });
      return;
    }

    // Courtesy pre-check; the route enforces the same one combined code+stdin budget.
    const oversize = payloadTooLarge(code, stdin);
    if (oversize) {
      executionMap.set(EXECUTION_KEY, {
        status: "error",
        runId,
        language,
        filename,
        stdin,
        startedBy,
        startedAt,
        finishedAt: Date.now(),
        error: oversize,
      });
      return;
    }

    executionMap.set(EXECUTION_KEY, {
      status: "running",
      runId,
      language,
      filename,
      stdin,
      startedBy,
      startedAt,
    });

    // Lost a race to another peer, or torn down mid-fetch: must not clobber current.
    const stale = () => {
      if (docRef.current !== yDoc) return true;
      const current = executionMap.get(EXECUTION_KEY);
      return current?.status === "idle" || current?.runId !== runId;
    };

    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code, stdin }),
      });

      const data: ExecuteSuccess | ExecuteFailure = await res.json();
      if (stale()) return;

      const finishedAt = Date.now();
      if (!res.ok || !data.success) {
        executionMap.set(EXECUTION_KEY, {
          status: "error",
          runId,
          language,
          filename,
          stdin,
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
        filename,
        stdin,
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
        filename,
        stdin,
        startedBy,
        startedAt,
        finishedAt: Date.now(),
        error: "Could not reach the execution service. Please try again.",
      });
    }
  }, [docRef, entryFile, language, stdin, user]);
}
