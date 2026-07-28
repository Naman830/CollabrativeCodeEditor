"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Editor, { OnChange, OnMount } from "@monaco-editor/react";
import * as Y from "yjs";
import type { MonacoBinding } from "y-monaco";
import type { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import IdentityDialog from "./IdentityDialog";
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

const LANGUAGES = [
  { label: "JavaScript", value: "javascript" },
  { label: "Python", value: "python" },
  { label: "TypeScript", value: "typescript" },
  { label: "Java", value: "java" },
  { label: "C++", value: "cpp" },
] as const;

const DEFAULT_CODE = `console.log("Hello, world!");\n`;

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// Everything below is built from *remote* awareness state, which any peer can
// set to anything at all — it never passes through our own input sanitizing.
// So both the label and the colour are treated as hostile here.

// A peer's colour is interpolated straight into rule bodies, where a value like
// `red } body { display: none } .x {` would escape the block and restyle the
// whole page. Only accept a plain hex colour.
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// Escape order matters: backslashes first, or we'd re-escape our own escapes.
// Newlines are illegal inside a CSS string and must become the \A escape.
function cssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\A ");
}

// Rebuilds the remote-cursor <style> tag from current awareness state, keyed
// by clientID. Regenerating the whole block (rather than patching it) means
// rules for clients who've left are simply dropped instead of lingering.
const AWARENESS_STYLE_ID = "yjs-remote-cursor-styles";

function renderAwarenessStyles(awareness: Awareness, localClientID: number) {
  let styleEl = document.getElementById(AWARENESS_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = AWARENESS_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  const rules: string[] = [];
  awareness.getStates().forEach((state, clientID) => {
    if (clientID === localClientID) return;
    const user = (state as { user?: { name: string; color: string } }).user;
    if (!user) return;

    const { name, color } = user;
    if (typeof name !== "string" || typeof color !== "string") return;
    if (!HEX_COLOR.test(color)) return;

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

type RunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: ExecuteSuccess }
  | { status: "error"; message: string };

type CodeEditorProps = {
  roomId: string;
};

export default function CodeEditor({ roomId }: CodeEditorProps) {
  const [language, setLanguage] = useState<string>("javascript");
  // Starts empty rather than at DEFAULT_CODE: the editor is genuinely empty
  // until the binding attaches, and Monaco's onChange fires on that first
  // programmatic setValue, so this catches up on its own.
  const [code, setCode] = useState<string>("");
  const [runState, setRunState] = useState<RunState>({ status: "idle" });

  // The editor instance is state, not a ref, so the Yjs effect below can list
  // it as a dependency and run once Monaco is actually mounted.
  const [editor, setEditor] = useState<MonacoEditor | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");

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
    let provider: WebsocketProvider | null = null;
    let binding: MonacoBinding | null = null;
    let awarenessChangeHandler: (() => void) | null = null;

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

      provider = new WebsocketProvider(WS_URL, roomId, yDoc);
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

      awarenessChangeHandler = () => renderAwarenessStyles(awareness, yDoc.clientID);
      awareness.on("change", awarenessChangeHandler);
      renderAwarenessStyles(awareness, yDoc.clientID);

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
    };
  }, [editor, roomId, user]);

  const handleEditorMount: OnMount = (mountedEditor) => {
    setEditor(mountedEditor);
  };

  const handleEditorChange: OnChange = (value) => {
    setCode(value ?? "");
  };

  const handleRun = async () => {
    setRunState({ status: "loading" });

    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code }),
      });

      const data: ExecuteSuccess | ExecuteFailure = await res.json();

      if (!res.ok || !data.success) {
        setRunState({
          status: "error",
          message: !data.success ? data.error : "Execution failed.",
        });
        return;
      }

      setRunState({ status: "success", result: data });
    } catch {
      setRunState({
        status: "error",
        message: "Could not reach the execution service. Please try again.",
      });
    }
  };

  const isLoading = runState.status === "loading";

  const hasRuntimeFailure =
    runState.status === "success" &&
    ((runState.result.compile && runState.result.compile.exitCode !== 0) ||
      runState.result.exitCode !== 0 ||
      runState.result.stderr.length > 0);

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e] text-zinc-200">
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
        {runState.status === "success" && (
          <span className="text-xs text-zinc-500">
            Exit code: {runState.result.exitCode ?? "—"}
          </span>
        )}
      </div>

      <div
        className={`h-48 overflow-auto border-t px-4 py-3 transition-colors ${
          runState.status === "error" || hasRuntimeFailure
            ? "border-red-900 bg-[#2a1414]"
            : "border-zinc-800 bg-black"
        }`}
      >
        {runState.status === "idle" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-600">
            Output will appear here...
          </pre>
        )}

        {runState.status === "loading" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-500">
            Running your code...
          </pre>
        )}

        {runState.status === "error" && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
            {runState.message}
          </pre>
        )}

        {runState.status === "success" && (
          <>
            {runState.result.compile && runState.result.compile.exitCode !== 0 && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
                {runState.result.compile.stderr}
              </pre>
            )}
            {runState.result.stdout && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-300">
                {runState.result.stdout}
              </pre>
            )}
            {runState.result.stderr && (
              <pre className="whitespace-pre-wrap font-mono text-sm text-red-400">
                {runState.result.stderr}
              </pre>
            )}
            {!runState.result.stdout && !runState.result.stderr && (
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
