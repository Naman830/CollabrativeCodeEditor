"use client";

// The room screen. It composes the pieces and owns nothing but local UI state:
//
//   hooks/useCollabRoom    the whole Yjs stack (doc, provider, awareness,
//                          binding) plus peers, toasts and shared run state
//   hooks/useCodeRunner    the Run button's POST -> shared-map write
//   components/EditorToolbar, OutputPanel, UserBar, ActivityToasts   the chrome
//
// `language` and `code` stay here because both are per-user: the dropdown is an
// editing preference, and `code` is only a mirror of Monaco's model for the
// size pre-check and Save. Neither belongs on the shared doc.

import { useState, useSyncExternalStore } from "react";
import Editor, { OnChange, OnMount } from "@monaco-editor/react";
import ActivityToasts from "./ActivityToasts";
import EditorToolbar from "./EditorToolbar";
import JoinRoomPrompt from "./JoinRoomPrompt";
import OutputPanel from "./OutputPanel";
import UserBar from "./UserBar";
import { useCodeRunner } from "../hooks/useCodeRunner";
import { useCollabRoom } from "../hooks/useCollabRoom";
import { downloadTextFile } from "../lib/download";
import { downloadFileName } from "../lib/languages";
import { configureMonacoLoader } from "../lib/monacoLoader";
import type { MonacoEditor } from "../lib/monacoTypes";
import {
  getIdentityServerSnapshot,
  getIdentitySnapshot,
  subscribeIdentity,
} from "../lib/user";

const EDITOR_OPTIONS = {
  fontSize: 14,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 12 },
  smoothScrolling: true,
  roundedSelection: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
} as const;

type CodeEditorProps = {
  roomId: string;
  /** Fired when the server refuses this room. Only `RoomGate` can act on it. */
  onRoomClosed?: () => void;
};

// Module scope, so it has run before any <Editor> in this module can mount.
configureMonacoLoader();

export default function CodeEditor({ roomId, onRoomClosed }: CodeEditorProps) {
  const [language, setLanguage] = useState<string>("javascript");
  // Starts empty, not at DEFAULT_CODE: the editor really is empty until the
  // binding attaches, and Monaco's onChange fires then, so this catches up.
  const [code, setCode] = useState<string>("");

  // State rather than a ref, so the collab hook's effect can depend on it and
  // run once Monaco has actually mounted.
  const [editor, setEditor] = useState<MonacoEditor | null>(null);

  // "unknown" until hydration resolves, then "absent" (prompt) or "present"
  // (connect). Arriving from the landing page means it is already present.
  const identity = useSyncExternalStore(
    subscribeIdentity,
    getIdentitySnapshot,
    getIdentityServerSnapshot,
  );
  const user = identity.status === "present" ? identity.user : null;

  const { syncStatus, peers, toasts, dismissToast, execState, docRef } = useCollabRoom({
    roomId,
    editor,
    user,
    onRoomClosed,
  });

  const handleRun = useCodeRunner({ docRef, code, language, user });

  // Purely local, unlike Run: nothing is written to the Y.Doc and no request
  // leaves the browser. `language` is per-user, so each peer downloads the same
  // text under their own extension.
  const handleSave = () => {
    downloadTextFile(downloadFileName(language), code);
  };

  const handleEditorMount: OnMount = (mountedEditor) => {
    setEditor(mountedEditor);
  };

  const handleEditorChange: OnChange = (value) => {
    setCode(value ?? "");
  };

  return (
    <div className="flex h-full flex-col bg-app text-zinc-200">
      <ActivityToasts toasts={toasts} onDismiss={dismissToast} />
      <UserBar peers={peers} connected={syncStatus === "connected"} />

      <EditorToolbar
        roomId={roomId}
        language={language}
        onLanguageChange={setLanguage}
        syncStatus={syncStatus}
        isRunning={execState.status === "running"}
        onRun={handleRun}
        canSave={code.length > 0}
        onSave={handleSave}
      />

      <div className="min-h-0 flex-1 border-b border-edge">
        <Editor
          height="100%"
          language={language}
          // No defaultValue: MonacoBinding resets the model to the Y.Text as
          // soon as it attaches, so content comes from the sync-gated seed.
          theme="vs-dark"
          onMount={handleEditorMount}
          onChange={handleEditorChange}
          options={EDITOR_OPTIONS}
        />
      </div>

      <OutputPanel state={execState} />

      {identity.status === "absent" && <JoinRoomPrompt />}
    </div>
  );
}
