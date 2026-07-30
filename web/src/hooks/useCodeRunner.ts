"use client";

// The Run button's behaviour: POST to `/api/execute`, then publish the result
// into the room's shared execution map so every peer sees the same run.
//
// Execution deliberately does NOT travel over the sync socket — the browser
// posts to the Next route, which proxies to Piston, and only the *result* is
// shared through Yjs. See "Architecture invariant" in CLAUDE.md.

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
  /** The live doc from `useCollabRoom`; null while disconnected. */
  docRef: React.RefObject<Y.Doc | null>;
  /**
   * The file Run executes (§10.1's "Run always executes the entry file"), which
   * is not necessarily the tab this client has open. Only its identity is passed
   * — the *text* is read from the doc at click time, below.
   */
  entryFile: RoomFile | null;
  /** The room's language, chosen at creation. Not a per-user preference. */
  language: string;
  /** The local draft from the output panel's input box; "" when unused. */
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
    // Guards a same-tab double-click. A different peer's concurrent click is
    // handled by the runId check below.
    if (executionMap.get(EXECUTION_KEY)?.status === "running") return;

    // Read at click time, out of the shared doc rather than out of Monaco. The
    // entry file usually has a model, but it need not be the one on screen and
    // need not have been opened at all this session — the Y.Text is the only
    // place its text is guaranteed to be current.
    const code = yDoc.getText(fileTextName(entryFile.id)).toString();
    const filename = entryFile.name;

    runCounterRef.current += 1;
    const runId = `${yDoc.clientID}-${runCounterRef.current}`;
    const startedBy: RunAttribution = { name: displayName(user), color: user.color };
    const startedAt = Date.now();

    // Says which file is empty rather than running nothing and reporting "(no
    // output)". Worth its own branch since §10.1: the entry file need not be the
    // tab you are looking at, so an empty one is invisible from where you sit.
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

    // The route enforces this too (it is reachable without the UI); checking
    // here just avoids sending a payload that will be refused. The failure goes
    // into the shared map because the oversized document is shared as well.
    // One combined budget for code and stdin — see `payloadTooLarge`.
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
