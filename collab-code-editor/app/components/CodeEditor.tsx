"use client";

import { useEffect, useRef, useState } from "react";
import Editor, { OnChange, OnMount } from "@monaco-editor/react";
import * as Y from "yjs";
import type { MonacoBinding } from "y-monaco";
import type { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";

const LANGUAGES = [
  { label: "JavaScript", value: "javascript" },
  { label: "Python", value: "python" },
  { label: "TypeScript", value: "typescript" },
  { label: "Java", value: "java" },
  { label: "C++", value: "cpp" },
] as const;

const DEFAULT_CODE = `console.log("Hello, world!");\n`;

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// Fixed palette so remote cursor colors stay legible on the vs-dark theme.
const CURSOR_COLORS = [
  "#e57373",
  "#64b5f6",
  "#81c784",
  "#ffb74d",
  "#ba68c8",
  "#4dd0e1",
  "#f06292",
  "#a1887f",
];

function randomUser() {
  const id = Math.floor(Math.random() * 9000) + 1000;
  const color = CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
  return { name: `User ${id}`, color };
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
    rules.push(`
      .yRemoteSelection-${clientID} {
        background-color: ${color}55;
      }
      .yRemoteSelectionHead-${clientID} {
        position: relative;
        border-left: 2px solid ${color};
      }
      .yRemoteSelectionHead-${clientID}::after {
        content: "${name.replace(/"/g, "'")}";
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
  const [code, setCode] = useState<string>(DEFAULT_CODE);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });

  const [yDoc] = useState(() => new Y.Doc());
  const bindingRef = useRef<MonacoBinding | null>(null);
  // handleEditorMount races the provider's dynamic import — await this
  // instead of a plain ref so the binding always picks up awareness even if
  // the editor finishes mounting first.
  const providerReadyRef = useRef<Promise<WebsocketProvider | null>>(Promise.resolve(null));
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");

  useEffect(() => {
    let cancelled = false;
    let provider: WebsocketProvider | null = null;
    let awarenessChangeHandler: (() => void) | null = null;

    const providerReady = (async () => {
      // y-websocket reads the `WebSocket` global at construction time — load
      // it client-side only, same as the y-monaco import in handleEditorMount.
      const { WebsocketProvider } = await import("y-websocket");
      if (cancelled) return null;

      provider = new WebsocketProvider(WS_URL, roomId, yDoc);
      provider.on("status", ({ status }: { status: SyncStatus }) => {
        setSyncStatus(status);
      });

      // Reuse the awareness instance the provider already creates — assign
      // this client a random name/color pair as its local presence state.
      const { awareness } = provider;
      awareness.setLocalStateField("user", randomUser());

      awarenessChangeHandler = () => renderAwarenessStyles(awareness, yDoc.clientID);
      awareness.on("change", awarenessChangeHandler);
      renderAwarenessStyles(awareness, yDoc.clientID);

      return provider;
    })();
    providerReadyRef.current = providerReady;

    return () => {
      cancelled = true;
      if (provider && awarenessChangeHandler) {
        provider.awareness.off("change", awarenessChangeHandler);
        // Clear local presence immediately so peers drop this cursor right
        // away instead of waiting on the server to notice the socket close.
        provider.awareness.setLocalState(null);
      }
      provider?.destroy();
      bindingRef.current?.destroy();
      yDoc.destroy();
      document.getElementById(AWARENESS_STYLE_ID)?.remove();
    };
  }, [yDoc, roomId]);

  const handleEditorMount: OnMount = async (editor) => {
    const yText = yDoc.getText("monaco");
    if (yText.length === 0) {
      yText.insert(0, DEFAULT_CODE);
    }

    const model = editor.getModel();
    if (model) {
      // y-monaco pulls in raw monaco-editor, which touches `window` at
      // import time — load it client-side only, after the editor mounts.
      const [{ MonacoBinding }, provider] = await Promise.all([
        import("y-monaco"),
        providerReadyRef.current,
      ]);
      bindingRef.current = new MonacoBinding(
        yText,
        model,
        new Set([editor]),
        provider?.awareness,
      );
    }
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
          defaultValue={DEFAULT_CODE}
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
    </div>
  );
}
