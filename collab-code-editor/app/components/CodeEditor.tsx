"use client";

// The room screen. It composes the pieces and owns nothing but local UI state:
//
//   hooks/useCollabRoom    the whole Yjs stack (doc, provider, awareness,
//                          binding) plus peers, toasts and shared run state
//   hooks/useCodeRunner    the Run button's POST -> shared-map write
//   hooks/useRoomLayout    which way the split runs and how big each side is
//   components/RoomChrome, EditorTabBar, OutputPanel, ActivityToasts   the chrome
//
// `language` and `code` stay here because both are per-user: the dropdown is an
// editing preference, and `code` is only a mirror of Monaco's model for the size
// pre-check and Save. Neither belongs on the shared doc.

import { useCallback, useState, useSyncExternalStore } from "react";
import type { OnChange, OnMount } from "@monaco-editor/react";
import { Group, Panel } from "react-resizable-panels";
import ActivityToasts from "./ActivityToasts";
import EditorPane from "./EditorPane";
import EditorTabBar from "./EditorTabBar";
import JoinRoomPrompt from "./JoinRoomPrompt";
import OutputPanel from "./OutputPanel";
import ResizeHandle from "./ResizeHandle";
import RoomChrome from "./RoomChrome";
import { IconButton, PANEL_STRIP_HEIGHT } from "./PanelStrip";
import { TerminalIcon } from "./icons";
import { useCodeRunner } from "../hooks/useCodeRunner";
import { useCollabRoom } from "../hooks/useCollabRoom";
import { EDITOR_PANEL_ID, OUTPUT_PANEL_ID, useRoomLayout } from "../hooks/useRoomLayout";
import { downloadTextFile } from "../lib/download";
import { downloadFileName } from "../lib/languages";
import { configureMonacoLoader } from "../lib/monacoLoader";
import type { MonacoEditor } from "../lib/monacoTypes";
import {
  getIdentityServerSnapshot,
  getIdentitySnapshot,
  subscribeIdentity,
} from "../lib/user";

// Module scope, so it has run before any <Editor> in this module can mount.
configureMonacoLoader();

type CodeEditorProps = {
  roomId: string;
  /** Fired when the server refuses this room. Only `RoomGate` can act on it. */
  onRoomClosed?: () => void;
};

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
  const layout = useRoomLayout();

  // Purely local, unlike Run: nothing is written to the Y.Doc and no request
  // leaves the browser. `language` is per-user, so each peer downloads the same
  // text under their own extension.
  //
  // `code` changes on every keystroke, so this and `handleRun` are new functions
  // on every keystroke too. They may only travel *up* into `RoomChrome` — never
  // down into the editor Panel, whose subtree has to stay referentially stable
  // for `EditorPane`'s `memo` to mean anything.
  const handleSave = useCallback(() => {
    downloadTextFile(downloadFileName(language), code);
  }, [code, language]);

  // Stable for the life of the component, which is what lets `EditorPane` skip
  // re-rendering on every keystroke.
  const handleEditorMount = useCallback<OnMount>((mountedEditor) => {
    setEditor(mountedEditor);
  }, []);
  const handleEditorChange = useCallback<OnChange>((value) => {
    setCode(value ?? "");
  }, []);

  // Side by side there is nothing legible to leave in a 36px-wide column, so the
  // output collapses to nothing and borrows the editor's strip for its restore
  // button. Stacked, it collapses to its own tab strip and keeps it.
  const outputFullyHidden = layout.outputCollapsed && layout.orientation === "horizontal";

  return (
    <div className="flex h-full min-h-0 flex-col bg-app text-fg">
      <ActivityToasts toasts={toasts} onDismiss={dismissToast} />

      <RoomChrome
        roomId={roomId}
        language={language}
        syncStatus={syncStatus}
        peers={peers}
        isRunning={execState.status === "running"}
        onRun={handleRun}
        canSave={code.length > 0}
        onSave={handleSave}
      />

      {/* ── ONE Group, whose `orientation` is a prop. ────────────────────────
          Never two Groups behind a ternary, and never a `key` on anything
          between here and `EditorPane`. `useCollabRoom`'s master effect is keyed
          on the Monaco instance, so remounting the editor destroys the Y.Doc,
          the provider, the awareness handler and the MonacoBinding — wiping the
          room's shared output for everyone and re-firing every join toast.

          Verified against react-resizable-panels@4.12.2's own source: `Group`
          and `Panel` both render `children` unconditionally, `orientation` only
          flips the container's flex-direction, and collapsing a Panel changes
          nothing but inline flex-grow/flex-basis. Nothing here can unmount
          Monaco. */}
      <Group
        id="room-split"
        orientation={layout.orientation}
        defaultLayout={layout.defaultLayout}
        // `onLayoutChanged`, NOT `onLayoutChange`: the latter fires on every
        // pointermove, and a re-render of this component mid-drag is what would
        // reach the editor subtree.
        onLayoutChanged={layout.handleLayoutChanged}
        // The library inflates the separator's hit rect to this many px
        // (default {coarse: 20, fine: 10}). A finger wants more than 20.
        resizeTargetMinimumSize={{ coarse: 28, fine: 10 }}
        className="min-h-0 min-w-0 flex-1"
      >
        <Panel
          id={EDITOR_PANEL_ID}
          // NOTE: `className` lands on the Panel's *inner* div, not its root —
          // the library keeps classes away from the flex sizing it owns.
          className="flex min-h-0 min-w-0 flex-col"
          // That inner div ships an inline `overflow: auto`, which no Tailwind
          // class can beat. Monaco draws its own scrollbars, so this has to be
          // an inline style too.
          style={{ overflow: "hidden" }}
          minSize="25"
        >
          <EditorTabBar
            language={language}
            onLanguageChange={setLanguage}
            actions={
              outputFullyHidden ? (
                <IconButton label="Show output" onClick={layout.toggleOutput}>
                  <TerminalIcon className="h-3.5 w-3.5" />
                </IconButton>
              ) : undefined
            }
          />

          <div className="min-h-0 flex-1">
            <EditorPane
              language={language}
              onMount={handleEditorMount}
              onChange={handleEditorChange}
              compact={layout.isNarrow}
            />
          </div>
        </Panel>

        <ResizeHandle orientation={layout.orientation} />

        <Panel
          id={OUTPUT_PANEL_ID}
          className="flex min-h-0 min-w-0 flex-col"
          style={{ overflow: "hidden" }}
          panelRef={layout.outputPanelRef}
          collapsible
          collapsedSize={layout.orientation === "vertical" ? PANEL_STRIP_HEIGHT : "0"}
          minSize="15"
          maxSize="75"
        >
          <OutputPanel
            state={execState}
            collapsed={layout.outputCollapsed}
            orientation={layout.orientation}
            canToggleOrientation={layout.canToggleOrientation}
            onToggleCollapsed={layout.toggleOutput}
            onToggleOrientation={layout.toggleOrientation}
          />
        </Panel>
      </Group>

      {identity.status === "absent" && <JoinRoomPrompt />}
    </div>
  );
}
