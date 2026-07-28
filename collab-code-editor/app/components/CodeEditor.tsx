"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Editor, { OnChange, OnMount } from "@monaco-editor/react";
import * as Y from "yjs";
import type { MonacoBinding } from "y-monaco";
import type { WebsocketProvider } from "y-websocket";
import ActivityToasts, { type ActivityToast } from "./ActivityToasts";
import IdentityDialog from "./IdentityDialog";
import UserBar from "./UserBar";
import { readPeers, type Peer } from "../lib/awareness";
import { MAX_CODE_BYTES, TOO_LARGE_MESSAGE, codeByteLength } from "../lib/execution";
import { LANGUAGES, downloadFileName } from "../lib/languages";
import { WS_URL } from "../lib/rooms";
import { playJoinSound, playLeaveSound } from "../lib/sound";
import {
  displayName,
  getIdentityServerSnapshot,
  getIdentitySnapshot,
  setActiveUser,
  subscribeIdentity,
} from "../lib/user";

// The editor instance Monaco hands back on mount, typed without importing
// monaco-editor itself (it touches `window` at import time).
type MonacoEditor = Parameters<OnMount>[0];

const DEFAULT_CODE = `console.log("Hello, world!");\n`;

// The close code the sync server sends for a room that no longer exists
// (`CLOSE_ROOM_NOT_FOUND` in server/yjsConnection.js). Any other close is an
// ordinary disconnect and must keep retrying.
const CLOSE_ROOM_NOT_FOUND = 4404;

// How long the room waits before treating a run as abandoned. If the peer who
// clicked Run disappears mid-flight, nothing else ever writes a result and every
// Run button stays disabled. This is the outermost of three nested timeouts —
// sandbox (10s compile + 5s run), then the route's 18s fetch abort, then this —
// so lowering it would report merely-slow runs as a lost connection.
const STALE_RUN_MS = 25_000;

// Escape order matters: backslashes first, or we re-escape our own escapes.
// Newlines are illegal in a CSS string and become the \A escape.
function cssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\A ");
}

const AWARENESS_STYLE_ID = "yjs-remote-cursor-styles";

// Rebuilds the remote-cursor <style> tag from the same deduped peers the user
// bar renders, so a caret label always matches that person's chip. Regenerating
// the whole block drops rules for clients who have left.
function renderAwarenessStyles(peers: Peer[]) {
  let styleEl = document.getElementById(AWARENESS_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = AWARENESS_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  const rules: string[] = [];
  peers.forEach(({ clientID, name, color, isLocal }) => {
    if (isLocal) return;

    rules.push(`
      .yRemoteSelection-${clientID} {
        background-color: ${color}55;
      }
      .yRemoteSelectionHead-${clientID} {
        position: relative;
        border-left: 2px solid ${color};
      }
      .yRemoteSelectionHead-${clientID}::after {
        content: "${cssString(name)}";
        position: absolute;
        top: -1.1em;
        left: -2px;
        white-space: nowrap;
        font-size: 11px;
        font-family: sans-serif;
        padding: 1px 4px;
        border-radius: 2px;
        color: #1e1e1e;
        background-color: ${color};
        pointer-events: none;
        z-index: 10;
      }
    `);
  });

  styleEl.textContent = rules.join("\n");
}

type SyncStatus = "connecting" | "connected" | "disconnected";

type ExecuteSuccess = {
  success: true;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  compile: { stdout: string; stderr: string; exitCode: number | null } | null;
  // Set when the sandbox stopped the program itself (output cap, timeout).
  // Optional because older records may still sit in a room's execution map.
  notice?: string | null;
};

type ExecuteFailure = {
  success: false;
  error: string;
};

type RunAttribution = { name: string; color: string };

// Lives in a Y.Map under one key, replaced whole, so every peer sees the same
// run. `runId` lets a run that lost a race recognise its own result as stale.
type ExecutionState =
  | { status: "idle" }
  | {
      status: "running";
      runId: string;
      language: string;
      startedBy: RunAttribution;
      startedAt: number;
    }
  | {
      status: "success";
      runId: string;
      language: string;
      startedBy: RunAttribution;
      startedAt: number;
      finishedAt: number;
      result: ExecuteSuccess;
    }
  | {
      status: "error";
      runId: string;
      language: string;
      startedBy: RunAttribution;
      startedAt: number;
      finishedAt: number;
      error: string;
    };

type CodeEditorProps = {
  roomId: string;
  /** Fired when the server refuses this room. Only `RoomGate` can act on it. */
  onRoomClosed?: () => void;
};

function PlayIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 19h14" />
    </svg>
  );
}

export default function CodeEditor({ roomId, onRoomClosed }: CodeEditorProps) {
  const [language, setLanguage] = useState<string>("javascript");
  // Starts empty, not at DEFAULT_CODE: the editor really is empty until the
  // binding attaches, and Monaco's onChange fires then, so this catches up.
  const [code, setCode] = useState<string>("");
  const [execState, setExecState] = useState<ExecutionState>({ status: "idle" });

  // State rather than a ref, so the Yjs effect can depend on it and run once
  // Monaco has actually mounted.
  const [editor, setEditor] = useState<MonacoEditor | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");

  // `handleRun` needs the live Y.Doc, but the doc must never live in component
  // state (see the effect below) — a ref triggers no render, so it is safe.
  const collabRef = useRef<Y.Doc | null>(null);
  const runCounterRef = useRef(0);

  // Read through a ref instead of being an effect dependency: an inline arrow
  // from the caller would otherwise rebuild the whole Yjs stack every render.
  const onRoomClosedRef = useRef(onRoomClosed);
  useEffect(() => {
    onRoomClosedRef.current = onRoomClosed;
  });

  // Awareness is a mutable instance inside the effect below, so React only sees
  // presence changes because they are mirrored into this state.
  const [peers, setPeers] = useState<Peer[]>([]);

  // Join/leave banners, diffed from consecutive peer snapshots below.
  const [toasts, setToasts] = useState<ActivityToast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // "unknown" until hydration resolves, then "absent" (prompt) or "present"
  // (connect). Arriving from the landing page means it is already present.
  const identity = useSyncExternalStore(
    subscribeIdentity,
    getIdentitySnapshot,
    getIdentityServerSnapshot,
  );
  const user = identity.status === "present" ? identity.user : null;

  // Owns the whole Yjs lifecycle: doc, provider, awareness and binding are all
  // created and torn down here, so switching rooms (or React's StrictMode
  // remount) rebuilds the stack instead of destroying a doc nothing recreates.
  // `user` is a dependency because no socket may open before we know who to
  // announce; it only ever goes null -> set once per mount.
  useEffect(() => {
    if (!editor || !user) return;
    const model = editor.getModel();
    if (!model) return;

    let cancelled = false;
    const yDoc = new Y.Doc();
    collabRef.current = yDoc;
    let provider: WebsocketProvider | null = null;
    let binding: MonacoBinding | null = null;
    let awarenessChangeHandler: (() => void) | null = null;
    // Baseline for join/leave detection. Null until the first snapshot, so
    // people already in the room don't each fire a "joined" toast at us.
    let knownPeers: Map<number, Peer> | null = null;

    // Execution state rides on the same Y.Doc as the code, so it syncs to every
    // peer (late joiners included) with no server changes. Registered here
    // rather than in the async block: a Y.Map needs neither socket nor Monaco.
    const executionMap = yDoc.getMap<ExecutionState>("execution");
    const applyExecutionState = () => {
      setExecState(executionMap.get("state") ?? { status: "idle" });
    };
    executionMap.observe(applyExecutionState);
    applyExecutionState();

    // Any peer can heal a run abandoned by whoever started it — there is no
    // owner once the record is shared, so whichever tick fires first wins and
    // the rest are identical no-ops.
    const staleRunWatchdog = setInterval(() => {
      const current = executionMap.get("state");
      if (
        current?.status === "running" &&
        Date.now() - current.startedAt > STALE_RUN_MS
      ) {
        executionMap.set("state", {
          status: "error",
          runId: current.runId,
          language: current.language,
          startedBy: current.startedBy,
          startedAt: current.startedAt,
          finishedAt: Date.now(),
          error: "Run did not complete (connection to the runner was lost).",
        });
      }
    }, 2000);

    (async () => {
      // Both packages touch browser globals at import time, so they can only be
      // loaded client-side.
      const [{ WebsocketProvider }, { MonacoBinding }] = await Promise.all([
        import("y-websocket"),
        import("y-monaco"),
      ]);
      if (cancelled) return;

      // `disableBc` turns off y-websocket's cross-tab BroadcastChannel. Two tabs
      // are meant to be two collaborators, and BC resurrects a closed tab in its
      // siblings' awareness — the user bar would then never drop anyone.
      provider = new WebsocketProvider(WS_URL, roomId, yDoc, { disableBc: true });
      provider.on("status", ({ status }: { status: SyncStatus }) => {
        setSyncStatus(status);
      });

      // A room can die during a session, and the reconnect is then refused with
      // this code. `disconnect()` is what stops y-websocket retrying forever;
      // every other close code is an ordinary drop that should keep retrying.
      const closedProvider = provider;
      closedProvider.on("connection-close", (event: CloseEvent) => {
        if (event?.code !== CLOSE_ROOM_NOT_FOUND) return;
        closedProvider.disconnect();
        if (!cancelled) onRoomClosedRef.current?.();
      });

      // Publish this user as local presence. `name` is the short caret label;
      // the raw parts ride along for the user bar's initials.
      const { awareness } = provider;
      awareness.setLocalStateField("user", {
        name: displayName(user),
        color: user.color,
        firstName: user.firstName,
        lastName: user.lastName,
      });

      // One handler for both consumers of awareness — the cursor styles and the
      // user bar must never drift apart, or one person looks like two.
      awarenessChangeHandler = () => {
        const nextPeers = readPeers(awareness, yDoc.clientID);
        renderAwarenessStyles(nextPeers);
        setPeers(nextPeers);

        // Diff against the previous snapshot for join/leave. Cursor moves also
        // fire this, but they never add or remove a clientID, so they diff to
        // nothing.
        const nextByClientID = new Map(nextPeers.map((peer) => [peer.clientID, peer]));
        if (knownPeers) {
          const newToasts: ActivityToast[] = [];
          nextByClientID.forEach((peer, clientID) => {
            if (peer.isLocal || knownPeers!.has(clientID)) return;
            newToasts.push({ id: `join-${clientID}-${Date.now()}`, kind: "join", name: peer.name, color: peer.color });
            playJoinSound();
          });
          knownPeers.forEach((peer, clientID) => {
            if (peer.isLocal || nextByClientID.has(clientID)) return;
            newToasts.push({ id: `leave-${clientID}-${Date.now()}`, kind: "leave", name: peer.name, color: peer.color });
            playLeaveSound();
          });
          if (newToasts.length > 0) {
            setToasts((prev) => [...prev, ...newToasts]);
          }
        }
        knownPeers = nextByClientID;
      };
      awareness.on("change", awarenessChangeHandler);
      awarenessChangeHandler();

      const yText = yDoc.getText("monaco");
      binding = new MonacoBinding(yText, model, new Set([editor]), awareness);

      // Seed the starter snippet only once the server has said what the room
      // already contains — seeding earlier would merge the boilerplate into
      // everyone else's document.
      provider.once("sync", (isSynced: boolean) => {
        if (cancelled || !isSynced || yText.length > 0) return;
        yText.insert(0, DEFAULT_CODE);
      });
    })();

    return () => {
      cancelled = true;
      // Cleared first so an in-flight run notices the teardown as early as
      // possible and discards its result.
      collabRef.current = null;
      clearInterval(staleRunWatchdog);
      executionMap.unobserve(applyExecutionState);
      if (provider && awarenessChangeHandler) {
        provider.awareness.off("change", awarenessChangeHandler);
        // Clear presence now so peers drop this cursor immediately instead of
        // waiting for the server to notice the socket close.
        provider.awareness.setLocalState(null);
      }
      binding?.destroy();
      provider?.destroy();
      yDoc.destroy();
      document.getElementById(AWARENESS_STYLE_ID)?.remove();
      // Peers, toasts and the last result all belong to the connection that
      // just died, not to whatever this reconnects to next.
      setPeers([]);
      setToasts([]);
      setExecState({ status: "idle" });
    };
  }, [editor, roomId, user]);

  const handleEditorMount: OnMount = (mountedEditor) => {
    setEditor(mountedEditor);
  };

  const handleEditorChange: OnChange = (value) => {
    setCode(value ?? "");
  };

  const handleRun = async () => {
    const yDoc = collabRef.current;
    if (!yDoc || !user) return;

    const executionMap = yDoc.getMap<ExecutionState>("execution");
    // Guards a same-tab double-click. A different peer's concurrent click is
    // handled by the runId check below.
    if (executionMap.get("state")?.status === "running") return;

    runCounterRef.current += 1;
    const runId = `${yDoc.clientID}-${runCounterRef.current}`;
    const startedBy: RunAttribution = { name: displayName(user), color: user.color };
    const startedAt = Date.now();

    // The route enforces this too (it is reachable without the UI); checking
    // here just avoids sending a payload that will be refused. The failure goes
    // into the shared map because the oversized document is shared as well.
    if (codeByteLength(code) > MAX_CODE_BYTES) {
      executionMap.set("state", {
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

    executionMap.set("state", { status: "running", runId, language, startedBy, startedAt });

    // This run may have lost a race to another peer's, or the effect may have
    // torn down while the fetch was in flight. Either way its result is stale
    // and must not clobber whatever is current.
    const stale = () => {
      if (collabRef.current !== yDoc) return true;
      const current = executionMap.get("state");
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
        executionMap.set("state", {
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

      executionMap.set("state", {
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
      executionMap.set("state", {
        status: "error",
        runId,
        language,
        startedBy,
        startedAt,
        finishedAt: Date.now(),
        error: "Could not reach the execution service. Please try again.",
      });
    }
  };

  // Purely local, unlike Run: nothing is written to the Y.Doc and no request
  // leaves the browser. `language` is per-user, so each peer downloads the same
  // text under their own extension.
  const handleSave = () => {
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadFileName(language);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  // Derived from shared state, so Run disables for every peer identically.
  const isLoading = execState.status === "running";

  const hasRuntimeFailure =
    execState.status === "success" &&
    ((execState.result.compile && execState.result.compile.exitCode !== 0) ||
      execState.result.exitCode !== 0 ||
      execState.result.stderr.length > 0 ||
      // A sandbox-side stop has no exit code, so without this the panel would
      // look like a clean run.
      Boolean(execState.result.notice));

  const outputFailed = execState.status === "error" || hasRuntimeFailure;

  return (
    <div className="flex h-full flex-col bg-app text-zinc-200">
      <ActivityToasts toasts={toasts} onDismiss={dismissToast} />
      <UserBar peers={peers} connected={syncStatus === "connected"} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-panel px-4 py-2">
        <label htmlFor="language-select" className="sr-only">
          Language
        </label>
        <select
          id="language-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-sm text-zinc-100 transition-colors hover:border-zinc-600 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>

        <span
          title={roomId}
          className="flex min-w-0 items-center gap-1.5 rounded-lg border border-edge bg-raised/60 px-2.5 py-1.5 text-xs text-zinc-500"
        >
          Room
          <span className="max-w-[14rem] truncate font-mono text-zinc-300">{roomId}</span>
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-2 rounded-lg border border-edge bg-raised/60 px-2.5 py-1.5 text-xs text-zinc-400">
            <span
              className={`h-2 w-2 rounded-full ${
                syncStatus === "connected"
                  ? "bg-emerald-500"
                  : syncStatus === "connecting"
                    ? "animate-pulse bg-amber-500"
                    : "bg-red-500"
              }`}
            />
            {syncStatus === "connected"
              ? "Synced"
              : syncStatus === "connecting"
                ? "Connecting…"
                : "Disconnected"}
          </span>

          <button
            type="button"
            onClick={handleRun}
            disabled={isLoading}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-lg shadow-emerald-600/20 transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-raised disabled:text-zinc-500 disabled:shadow-none"
          >
            {isLoading ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-500/40 border-t-zinc-300" />
            ) : (
              <PlayIcon />
            )}
            {isLoading ? "Running…" : "Run"}
          </button>

          <button
            type="button"
            onClick={handleSave}
            // No room-wide lock here — Save touches no shared state, so an empty
            // editor is the only thing worth guarding against.
            disabled={code.length === 0}
            title={`Download ${downloadFileName(language)}`}
            className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-4 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-[#2c2c2c] disabled:cursor-not-allowed disabled:border-edge disabled:bg-transparent disabled:text-zinc-600"
          >
            <DownloadIcon />
            Save
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 border-b border-edge">
        <Editor
          height="100%"
          language={language}
          // No defaultValue: MonacoBinding resets the model to the Y.Text as
          // soon as it attaches, so content comes from the sync-gated seed.
          theme="vs-dark"
          onMount={handleEditorMount}
          onChange={handleEditorChange}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            smoothScrolling: true,
            roundedSelection: false,
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          }}
        />
      </div>

      <div className="flex h-56 flex-col bg-panel">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge px-4 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Output
          </span>

          {execState.status !== "idle" && (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: execState.startedBy.color }}
              />
              Run by {execState.startedBy.name} ·{" "}
              {LANGUAGES.find((lang) => lang.value === execState.language)?.label ??
                execState.language}
              {execState.status === "success" && (
                <> · Exit code: {execState.result.exitCode ?? "—"}</>
              )}
            </span>
          )}
        </div>

        <div
          className={`flex-1 overflow-auto px-4 py-3 font-mono text-sm transition-colors ${
            outputFailed ? "bg-[#1f1414]" : "bg-[#101010]"
          }`}
        >
          {execState.status === "idle" && (
            <pre className="whitespace-pre-wrap text-zinc-600">
              Output will appear here…
            </pre>
          )}

          {execState.status === "running" && (
            <pre className="whitespace-pre-wrap text-zinc-500">Running your code…</pre>
          )}

          {execState.status === "error" && (
            <pre className="whitespace-pre-wrap text-red-400">{execState.error}</pre>
          )}

          {execState.status === "success" && (
            <>
              {execState.result.compile && execState.result.compile.exitCode !== 0 && (
                <pre className="whitespace-pre-wrap text-red-400">
                  {execState.result.compile.stderr}
                </pre>
              )}
              {execState.result.stdout && (
                <pre className="whitespace-pre-wrap text-zinc-300">
                  {execState.result.stdout}
                </pre>
              )}
              {execState.result.stderr && (
                <pre className="whitespace-pre-wrap text-red-400">
                  {execState.result.stderr}
                </pre>
              )}
              {/* Last, because it explains why the output above stops where it
                  does — the program was killed mid-write, not finished. */}
              {execState.result.notice && (
                <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-amber-300">
                  {execState.result.notice}
                </pre>
              )}
              {!execState.result.stdout &&
                !execState.result.stderr &&
                !execState.result.notice && (
                  <pre className="whitespace-pre-wrap text-zinc-600">(no output)</pre>
                )}
            </>
          )}
        </div>
      </div>

      {/* Deep links and the landing page's Join button both arrive without an
          identity. No onCancel: there is nowhere to fall back to, and the room
          stays disconnected until a name is entered. */}
      {identity.status === "absent" && (
        <IdentityDialog
          title="Join this room"
          description="Pick a name so everyone can tell your cursor apart."
          submitLabel="Join Room"
          onSubmit={setActiveUser}
        />
      )}
    </div>
  );
}
