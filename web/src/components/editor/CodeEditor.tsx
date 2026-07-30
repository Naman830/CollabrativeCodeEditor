"use client";


import { useCallback, useState, useSyncExternalStore, type KeyboardEvent } from "react";
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
import { TerminalIcon } from "@/components/ui/icons";
import { useCodeRunner } from "@/hooks/useCodeRunner";
import { useCollabRoom } from "@/hooks/useCollabRoom";
import { useEditorShortcuts } from "@/hooks/useEditorShortcuts";
import { EDITOR_PANEL_ID, OUTPUT_PANEL_ID, useRoomLayout } from "@/hooks/useRoomLayout";
import { useRoomPersistence } from "@/hooks/useRoomPersistence";
import { PROJECT_ZIP_NAME, downloadTextFile, downloadZipFile } from "@/lib/editor/download";
import { configureMonacoLoader } from "@/lib/editor/monacoLoader";
import type { MonacoApi, MonacoEditor } from "@/lib/editor/monacoTypes";
import { modelPathFor } from "@/lib/collab/roomFiles";
import {
  getIdentityServerSnapshot,
  getIdentitySnapshot,
  subscribeIdentity,
} from "@/lib/collab/user";

// INVARIANT: module scope — must run before any <Editor> here can mount.
configureMonacoLoader();

type CodeEditorProps = {
  roomId: string;
  language: string;
  onRoomClosed?: () => void;
};

export default function CodeEditor({ roomId, language, onRoomClosed }: CodeEditorProps) {
  // Mirrors only the *active* file — Save and Run read the shared doc instead.
  const [code, setCode] = useState<string>("");

  // INVARIANT: the stdin draft stays local; only the value a run *used* is shared.
  const [stdin, setStdin] = useState<string>("");
  const [stdinOpen, setStdinOpen] = useState<boolean>(false);

  // State rather than a ref, so the collab hook's effects can depend on both.
  const [editor, setEditor] = useState<MonacoEditor | null>(null);
  const [monacoApi, setMonacoApi] = useState<MonacoApi | null>(null);

  const identity = useSyncExternalStore(
    subscribeIdentity,
    getIdentitySnapshot,
    getIdentityServerSnapshot,
  );
  const user = identity.status === "present" ? identity.user : null;

  const room = useCollabRoom({
    roomId,
    language,
    editor,
    monaco: monacoApi,
    user,
    onRoomClosed,
  });

  const persistence = useRoomPersistence({
    peers: room.peers,
    syncStatus: room.syncStatus,
    user,
    didEdit: room.didEdit,
  });

  // Run executes the room's *entry* file, not necessarily the open tab.
  const handleRun = useCodeRunner({
    docRef: room.docRef,
    entryFile: room.entryFile,
    language,
    stdin,
    user,
  });
  const layout = useRoomLayout();

  // Reads the shared doc, not Monaco: a file never opened here has no model.
  // INVARIANT: this and handleRun may travel only *up* into RoomChrome, never
  // down into the editor Panel, whose subtree must stay referentially stable.
  const handleSave = useCallback(() => {
    const files = room.files.map((file) => ({
      filename: file.name,
      content: room.readFile(file.id),
    }));
    if (files.length === 0) return;
    if (files.length === 1) {
      // Guard here, not only on the button, so Ctrl+S inherits it.
      if (files[0].content.length === 0) return;
      downloadTextFile(files[0].filename, files[0].content);
      return;
    }
    void downloadZipFile(files);
  }, [room]);

  const handleDownloadFile = useCallback(
    (fileId: string) => {
      const file = room.files.find((entry) => entry.id === fileId);
      if (!file) return;
      downloadTextFile(file.name, room.readFile(fileId));
    },
    [room],
  );

  useEditorShortcuts({ editor, monaco: monacoApi, onRun: handleRun, onSave: handleSave });

  // INVARIANT: element-scoped, never a window keydown listener.
  const handleStdinKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void handleRun();
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSave();
      }
    },
    [handleRun, handleSave],
  );

  // INVARIANT: must stay stable — EditorPane's `memo` depends on it.
  const handleEditorMount = useCallback<OnMount>((mountedEditor, monaco) => {
    setEditor(mountedEditor);
    setMonacoApi(monaco);
  }, []);
  const handleEditorChange = useCallback<OnChange>((value) => {
    setCode(value ?? "");
  }, []);

  const toggleStdin = useCallback(() => setStdinOpen((open) => !open), []);

  // Collapsed side by side leaves no strip, so it borrows the editor's.
  const outputFullyHidden = layout.outputCollapsed && layout.orientation === "horizontal";

  const canSave = room.files.length > 1 || code.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-app text-fg">
      <ActivityToasts toasts={room.toasts} onDismiss={room.dismissToast} />

      <RoomChrome
        roomId={roomId}
        language={language}
        saveName={room.files.length > 1 ? PROJECT_ZIP_NAME : (room.files[0]?.name ?? "")}
        syncStatus={room.syncStatus}
        peers={room.peers}
        isRunning={room.execState.status === "running"}
        entryFileName={room.entryFile?.name ?? null}
        onRun={handleRun}
        canSave={canSave}
        onSave={handleSave}
        persistenceStatus={persistence.status}
        persistenceRemainingMs={persistence.remainingMs}
        isLastPeer={persistence.isLastPeer}
      />

      {/* The room's only landmark and its only heading. Without them the page had no bypass
          mechanism at all — axe reported landmark-one-main, page-has-heading-one AND region
          (every control outside a landmark) on the app's most control-dense screen.
          A static wrapper, so the Group below is still never remounted at runtime. */}
      <main id="main-content" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <h1 className="sr-only">Collaborative editor — room {roomId}</h1>

        {/* INVARIANT: ONE Group, never two behind a ternary, and never a `key`
            between here and EditorPane — a remount destroys the Y.Doc. */}
        <Group
        id="room-split"
        orientation={layout.orientation}
        defaultLayout={layout.defaultLayout}
        // NOT `onLayoutChange`: that fires on every pointermove, re-rendering
        // this component mid-drag.
        onLayoutChanged={layout.handleLayoutChanged}
        resizeTargetMinimumSize={{ coarse: 28, fine: 10 }}
        className="min-h-0 min-w-0 flex-1"
      >
        <Panel
          id={EDITOR_PANEL_ID}
          className="flex min-h-0 min-w-0 flex-col"
          // The Panel's inner div ships an inline `overflow: auto`; only an
          // inline style beats it.
          style={{ overflow: "hidden" }}
          minSize="25"
        >
          <EditorTabBar
            files={room.files}
            activeFileId={room.activeFile?.id ?? null}
            entryFileId={room.entryFile?.id ?? null}
            onSelect={room.setActiveFileId}
            onCreate={room.createFile}
            onRename={room.renameFile}
            onDelete={room.deleteFile}
            onSetEntry={room.setEntryFileId}
            onDownload={handleDownloadFile}
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
              path={room.activeFile ? modelPathFor(roomId, room.activeFile.id) : undefined}
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
            state={room.execState}
            collapsed={layout.outputCollapsed}
            orientation={layout.orientation}
            canToggleOrientation={layout.canToggleOrientation}
            onToggleCollapsed={layout.toggleOutput}
            onToggleOrientation={layout.toggleOrientation}
            stdin={stdin}
            stdinOpen={stdinOpen}
            onStdinChange={setStdin}
            onToggleStdin={toggleStdin}
            onStdinKeyDown={handleStdinKeyDown}
          />
        </Panel>
        </Group>
      </main>

      {identity.status === "absent" && <JoinRoomPrompt />}
    </div>
  );
}
