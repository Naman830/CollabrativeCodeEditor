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
import { LANGUAGES, downloadFileName } from "../lib/languages";
import { playJoinSound, playLeaveSound } from "../lib/sound";
import {
  displayName,
  getIdentityServerSnapshot,
  getIdentitySnapshot,
  setActiveUser,
  subscribeIdentity,
} from "../lib/user";

// The editor instance Monaco hands back on mount, without importing
// monaco-editor itself (it touches `window` at import time).
type MonacoEditor = Parameters<OnMount>[0];

const DEFAULT_CODE = `console.log("Hello, world!");\n`;

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// If the peer who started a run disappears mid-flight (tab closed, crash,
// network drop), their fetch to /api/execute is cancelled by the browser and
// nothing else ever writes to the execution map — every peer's Run button
// stays disabled forever, since it's gated on `status === "running"`. This
// bounds how long the room waits before treating an abandoned run as failed.
// Set above the API route's own PISTON_TIMEOUT_MS (15s) plus margin for the
// request/response round trip, so a run that's merely slow — not abandoned —
// is never pre-empted by this.
const STALE_RUN_MS = 20_000;

// Everything below is built from `readPeers`'s output, not raw awareness state
// directly — `lib/awareness` is the boundary that sanitizes and deduplicates
// what any peer can set its own `user` field to.

// Escape order matters: backslashes first, or we'd re-escape our own escapes.
// Newlines are illegal inside a CSS string and must become the \A escape.
function cssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\A ");
}

// Rebuilds the remote-cursor <style> tag from the same deduped Peer[] the user
// bar renders, keyed by clientID. Regenerating the whole block (rather than
// patching it) means rules for clients who've left are simply dropped instead
// of lingering. Sourcing this from `readPeers`'s output rather than raw
// awareness state matters: readPeers is what resolves duplicate names/colors,
// and the cursor label must match the bar chip for the same person exactly.
const AWARENESS_STYLE_ID = "yjs-remote-cursor-styles";

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
};

type ExecuteFailure = {
  success: false;
  error: string;
};

// Lives in a Y.Map (single key, whole-record replacement) rather than local
// state, so every peer sees the same run — see the `execution` map wiring
// below. `runId` exists to resolve the one race the room-wide lock can't:
// two peers clicking Run before either has received the other's "running"
// write both converge on the same winning record via Yjs, and the loser's
// eventual Piston response must recognise itself as stale and discard rather
// than clobber the winner.
type RunAttribution = { name: string; color: string };

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
};

export default function CodeEditor({ roomId }: CodeEditorProps) {
  const [language, setLanguage] = useState<string>("javascript");
  // Starts empty rather than at DEFAULT_CODE: the editor is genuinely empty
  // until the binding attaches, and Monaco's onChange fires on that first
  // programmatic setValue, so this catches up on its own.
  const [code, setCode] = useState<string>("");
  const [execState, setExecState] = useState<ExecutionState>({ status: "idle" });

  // The editor instance is state, not a ref, so the Yjs effect below can list
  // it as a dependency and run once Monaco is actually mounted.
  const [editor, setEditor] = useState<MonacoEditor | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");

  // `handleRun` needs the live `Y.Doc` to write into the shared execution map,
  // but per this repo's lifecycle rules the doc itself must never live in
  // component state (a state-held doc with nothing to recreate it breaks room
  // switching and StrictMode remounts) — a ref is fine since it triggers no
  // render. Nulled first on effect cleanup so an in-flight run notices the
  // teardown immediately.
  const collabRef = useRef<Y.Doc | null>(null);
  const runCounterRef = useRef(0);

  // Presence for the user bar. Mirrors awareness rather than being derived from
  // it on render: awareness is a mutable instance living inside the effect
  // below, so React has no way to see a change to it without being told.
  const [peers, setPeers] = useState<Peer[]>([]);

  // Join/leave banners, diffed from consecutive `readPeers` snapshots inside
  // the awareness handler below (see `knownPeers` in the effect).
  const [toasts, setToasts] = useState<ActivityToast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // "unknown" until hydration resolves, then "absent" (prompt) or "present"
  // (connect). Arriving here from the landing page means it is already present.
  const identity = useSyncExternalStore(
    subscribeIdentity,
    getIdentitySnapshot,
    getIdentityServerSnapshot,
  );
  const user = identity.status === "present" ? identity.user : null;

  // Owns the entire Yjs lifecycle — doc, provider, awareness, and binding are
  // all created here and all torn down together. Everything is scoped to this
  // effect rather than to the component, so switching rooms (or React's
  // StrictMode remount in dev) rebuilds the stack instead of leaving the
  // cleanup to destroy a Y.Doc that nothing ever recreates.
  // `user` joins the dependency list rather than being read from a ref: we must
  // not open a socket before we know who to announce, or peers would briefly
  // see an anonymous cursor. It only ever transitions null -> set once per
  // mount, so the stack is still built exactly once.
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
    // Baseline for join/leave detection, keyed by clientID. Stays null until
    // the first awareness snapshot arrives so that everyone already in the
    // room when *we* connect doesn't generate a "joined" toast for us — only
    // changes after that baseline do.
    let knownPeers: Map<number, Peer> | null = null;

    // Shared execution state rides on the same Y.Doc as the code itself, so it
    // syncs to every peer (including late joiners) via the same sync protocol
    // — no server changes, no separate channel. Registered synchronously here
    // rather than inside the async IIFE below: Y.Map needs neither the
    // WebSocket provider nor Monaco to exist.
    const executionMap = yDoc.getMap<ExecutionState>("execution");
    const applyExecutionState = () => {
      setExecState(executionMap.get("state") ?? { status: "idle" });
    };
    executionMap.observe(applyExecutionState);
    applyExecutionState();

    // Any connected peer can heal a run abandoned by whoever started it —
    // there's no single "owner" once the record is shared, so every client
    // runs this same check and whichever fires first wins (idempotent: they'd
    // all write an equivalent error record).
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

    // No need to reset syncStatus here: the room route keys this component on
    // roomId, so a room switch remounts with the "connecting" initial state,
    // and every transition after that arrives via the provider's status event.
    (async () => {
      // Both packages touch browser globals at import time (y-websocket reads
      // `WebSocket`, y-monaco pulls in raw monaco-editor which reads `window`),
      // so they have to be loaded client-side only.
      const [{ WebsocketProvider }, { MonacoBinding }] = await Promise.all([
        import("y-websocket"),
        import("y-monaco"),
      ]);
      if (cancelled) return;

      // `disableBc` turns off y-websocket's cross-tab BroadcastChannel. Two tabs
      // of this app are meant to be two separate collaborators (identity lives
      // in sessionStorage precisely so that holds), and the BC channel fights
      // that: tabs sync out-of-band, and a tab that closes gets resurrected in
      // its siblings' awareness — the user bar then never drops anyone.
      // Everything still syncs through the server, which is the only path a
      // real pair of collaborators has anyway.
      provider = new WebsocketProvider(WS_URL, roomId, yDoc, { disableBc: true });
      provider.on("status", ({ status }: { status: SyncStatus }) => {
        setSyncStatus(status);
      });

      // Reuse the awareness instance the provider already creates — publish
      // the name and colour this user chose as its local presence state.
      // `name` is the pre-shortened cursor label; the raw parts ride along for
      // the user bar, which needs initials.
      const { awareness } = provider;
      awareness.setLocalStateField("user", {
        name: displayName(user),
        color: user.color,
        firstName: user.firstName,
        lastName: user.lastName,
      });

      // One handler for both consumers of awareness: the remote-cursor styles
      // and the user bar. They must not drift apart — a peer shown in the bar
      // with one colour and a caret in another reads as two different people.
      awarenessChangeHandler = () => {
        const nextPeers = readPeers(awareness, yDoc.clientID);
        renderAwarenessStyles(nextPeers);
        setPeers(nextPeers);

        // Diff against the previous snapshot to find who joined/left. This
        // fires on every awareness change, including cursor moves, but a
        // cursor move never adds or removes a clientID key, so the diff below
        // is a no-op for those — only actual presence changes produce toasts.
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

      // Seed the starter snippet only once the server has told us what this
      // room already contains. Seeding earlier would insert DEFAULT_CODE into
      // a still-empty local doc, and the CRDT would then merge that boilerplate
      // into the existing document for everyone else in the room.
      provider.once("sync", (isSynced: boolean) => {
        if (cancelled || !isSynced || yText.length > 0) return;
        yText.insert(0, DEFAULT_CODE);
      });
    })();

    return () => {
      cancelled = true;
      // Null this out first, before anything else, so a `handleRun` call still
      // in flight sees the teardown as early as possible and discards its
      // result instead of writing into a doc we no longer own.
      collabRef.current = null;
      clearInterval(staleRunWatchdog);
      executionMap.unobserve(applyExecutionState);
      if (provider && awarenessChangeHandler) {
        provider.awareness.off("change", awarenessChangeHandler);
        // Clear local presence immediately so peers drop this cursor right
        // away instead of waiting on the server to notice the socket close.
        provider.awareness.setLocalState(null);
      }
      binding?.destroy();
      provider?.destroy();
      yDoc.destroy();
      document.getElementById(AWARENESS_STYLE_ID)?.remove();
      // Peers belong to the connection that just died. Leaving them would show
      // the old room's occupants for as long as the new socket takes to sync.
      setPeers([]);
      // Same reasoning: any pending join/leave toasts belong to the
      // connection that just died, not to whatever room this reconnects to.
      setToasts([]);
      // Same reasoning as `setPeers([])`: the last run's result belongs to the
      // connection that just died, not to whatever room this component
      // reconnects to next.
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
    // Defense in depth against a same-tab double-click; can't prevent a
    // different peer's concurrent click (see the runId check below).
    if (executionMap.get("state")?.status === "running") return;

    runCounterRef.current += 1;
    const runId = `${yDoc.clientID}-${runCounterRef.current}`;
    const startedBy: RunAttribution = { name: displayName(user), color: user.color };
    const startedAt = Date.now();

    executionMap.set("state", { status: "running", runId, language, startedBy, startedAt });

    // A run this client started may lose a race to a concurrent run from
    // another peer (both write "running" before either has seen the other's
    // update; Yjs converges both replicas on one winner) — or the effect may
    // have torn down (room switch/unmount) while the fetch was in flight.
    // Either way, this run's own result is stale and must be discarded rather
    // than clobbering whatever is now current.
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
  // leaves the browser. `language` is a per-user preference, so each peer
  // downloads the same shared text under their own extension.
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

  // Derived from the shared state, not a local flag, so the Run button
  // disables for every peer identically.
  const isLoading = execState.status === "running";

  const hasRuntimeFailure =
    execState.status === "success" &&
    ((execState.result.compile && execState.result.compile.exitCode !== 0) ||
      execState.result.exitCode !== 0 ||
      execState.result.stderr.length > 0);

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e] text-zinc-200">
      <ActivityToasts toasts={toasts} onDismiss={dismissToast} />
      <UserBar peers={peers} connected={syncStatus === "connected"} />

      <div className="flex items-center gap-3 border-b border-zinc-800 bg-[#252526] px-4 py-2">
        <label htmlFor="language-select" className="text-sm text-zinc-400">
          Language
        </label>
        <select
          id="language-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="rounded border border-zinc-700 bg-[#3c3c3c] px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>

        <span className="text-xs text-zinc-500">
          Room: <span className="font-mono text-zinc-300">{roomId}</span>
        </span>

        <div className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
          <span
            className={`h-2 w-2 rounded-full ${
              syncStatus === "connected"
                ? "bg-green-500"
                : syncStatus === "connecting"
                  ? "bg-amber-500"
                  : "bg-red-500"
            }`}
          />
          {syncStatus === "connected"
            ? "Synced"
            : syncStatus === "connecting"
              ? "Connecting…"
              : "Disconnected"}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language={language}
          // No defaultValue: MonacoBinding resets the model to the Y.Text
          // contents as soon as it attaches, so initial content comes from the
          // sync-gated seed above, never from Monaco itself.
          theme="vs-dark"
          onMount={handleEditorMount}
          onChange={handleEditorChange}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
          }}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-zinc-800 bg-[#252526] px-4 py-2">
        <button
          type="button"
          onClick={handleRun}
          disabled={isLoading}
          className="flex items-center gap-2 rounded bg-green-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:bg-green-800 disabled:text-zinc-300"
        >
          {isLoading && (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {isLoading ? "Running..." : "Run"}
        </button>
        <button
          type="button"
          onClick={handleSave}
          // No room-wide lock here (Save touches no shared state), so an
          // empty editor is the only thing worth guarding against.
          disabled={code.length === 0}
          title={`Download ${downloadFileName(language)}`}
          className="rounded border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-500"
        >
          Save
        </button>
        {execState.status !== "idle" && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-500">
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
        className={`h-48 overflow-auto border-t px-4 py-3 transition-colors ${
          execState.status === "error" || hasRuntimeFailure
            ? "border-red-900 bg-[#2a1414]"
            : "border-zinc-800 bg-black"
        }`}
      >
        {execState.status === "idle" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-600">
            Output will appear here...
          </pre>
        )}

        {execState.status === "running" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-500">
            Running your code...
          </pre>
        )}

        {execState.status === "error" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
            {execState.error}
          </pre>
        )}

        {execState.status === "success" && (
          <>
            {execState.result.compile && execState.result.compile.exitCode !== 0 && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
                {execState.result.compile.stderr}
              </pre>
            )}
            {execState.result.stdout && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-300">
                {execState.result.stdout}
              </pre>
            )}
            {execState.result.stderr && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
                {execState.result.stderr}
              </pre>
            )}
            {!execState.result.stdout && !execState.result.stderr && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-600">
                (no output)
              </pre>
            )}
          </>
        )}
      </div>

      {/* Deep links and the landing page's Join button both land here without an
          identity. No onCancel: there is nowhere to fall back to, and the room
          stays disconnected until a name is entered. Monaco keeps loading
          underneath in the meantime. */}
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
