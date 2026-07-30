"use client";

// The room screen. It composes the pieces and owns nothing but local UI state:
//
//   hooks/useCollabRoom    the whole Yjs stack (doc, provider, awareness, the
//                          per-file bindings) plus peers, toasts, the file list
//                          and shared run state
//   hooks/useCodeRunner    the Run button's POST -> shared-map write
//   hooks/useRoomLayout    which way the split runs and how big each side is
//   components/RoomChrome, EditorTabBar, OutputPanel, ActivityToasts   the chrome
//
// `language` is no longer state here: since §10.1 it is a property of the room,
// chosen once at creation and handed down by `RoomGate`. `code` stays, and stays
// per-user, because it is only a mirror of whichever model Monaco currently has
// on screen — Save and Run both read the *shared doc* instead (see below).

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

// Module scope, so it has run before any <Editor> in this module can mount.
configureMonacoLoader();

type CodeEditorProps = {
  roomId: string;
  /** The room's language, from `GET /rooms/:roomId` via `RoomGate`. */
  language: string;
  /** Fired when the server refuses this room. Only `RoomGate` can act on it. */
  onRoomClosed?: () => void;
};

export default function CodeEditor({ roomId, language, onRoomClosed }: CodeEditorProps) {
  // Starts empty, not at a starter snippet: the editor really is empty until a
  // binding attaches, and Monaco's onChange fires then, so this catches up.
  // Mirrors only the *active* file — see `handleSave` for why that is enough.
  const [code, setCode] = useState<string>("");

  // The stdin draft (§10.4). Local for the same reason the active tab is: the
  // box you type into is yours, and only the value a run *used* is shared — it
  // travels on the `ExecutionState` record, so a remote run can never overwrite
  // what someone is halfway through typing.
  const [stdin, setStdin] = useState<string>("");
  const [stdinOpen, setStdinOpen] = useState<boolean>(false);

  // State rather than a ref, so the collab hook's effects can depend on both and
  // run once Monaco has actually mounted.
  const [editor, setEditor] = useState<MonacoEditor | null>(null);
  // The namespace from `onMount`. Needed for `KeyMod`/`KeyCode` (which cannot be
  // statically imported — see `lib/editor/monacoTypes.ts`) and, since §10.1, to create
  // one model per file.
  const [monacoApi, setMonacoApi] = useState<MonacoApi | null>(null);

  // "unknown" until hydration resolves, then "absent" (prompt) or "present"
  // (connect). Arriving from the landing page means it is already present.
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

  // The leaving warning and the "is this being kept?" estimate (§10.8). One
  // hook because they are one idea: the warning is only actionable if you know
  // what closing the tab actually costs.
  const persistence = useRoomPersistence({
    peers: room.peers,
    syncStatus: room.syncStatus,
    user,
    didEdit: room.didEdit,
  });

  // Run executes the room's *entry* file, which need not be the tab this client
  // has open (§10.1) — so the runner takes the file, not this component's `code`.
  const handleRun = useCodeRunner({
    docRef: room.docRef,
    entryFile: room.entryFile,
    language,
    stdin,
    user,
  });
  const layout = useRoomLayout();

  // Purely local, unlike Run: nothing is written to the Y.Doc and no request
  // leaves the browser.
  //
  // §10.1's two shapes: one file downloads directly as it always did, 2+ zip
  // into `project.zip`. Contents come from the shared doc rather than from
  // Monaco, because a file that has never been opened in this tab has no model
  // to read — the `Y.Text` is the only place every file's text is current.
  //
  // `readFile` and the file list are stable-ish, but `code` changes on every
  // keystroke, so this and `handleRun` are new functions on every keystroke too.
  // They may only travel *up* into `RoomChrome` — never down into the editor
  // Panel, whose subtree has to stay referentially stable for `EditorPane`'s
  // `memo` to mean anything.
  const handleSave = useCallback(() => {
    const files = room.files.map((file) => ({
      filename: file.name,
      content: room.readFile(file.id),
    }));
    if (files.length === 0) return;
    if (files.length === 1) {
      // The empty-document guard lives here rather than only on the button, so
      // the Ctrl+S shortcut has exactly the same disabled state as the control
      // it mirrors instead of silently downloading an empty file.
      if (files[0].content.length === 0) return;
      downloadTextFile(files[0].filename, files[0].content);
      return;
    }
    void downloadZipFile(files);
  }, [room]);

  /** §10.1's per-file "download this file only", from a tab's own menu. */
  const handleDownloadFile = useCallback(
    (fileId: string) => {
      const file = room.files.find((entry) => entry.id === fileId);
      if (!file) return;
      downloadTextFile(file.name, room.readFile(fileId));
    },
    [room],
  );

  // Both shortcuts, registered on the Monaco instance rather than on `window`.
  useEditorShortcuts({ editor, monaco: monacoApi, onRun: handleRun, onSave: handleSave });

  // The stdin box is a real focusable control outside the editor, so Monaco's
  // keybindings — and its `preventDefault` — do not reach it. This is
  // element-scoped, not a `window` listener, so it keeps §10.5's rule while
  // closing the one gap §10.4 opened.
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

  // Stable for the life of the component, which is what lets `EditorPane` skip
  // re-rendering on every keystroke. Both setters land in one render.
  const handleEditorMount = useCallback<OnMount>((mountedEditor, monaco) => {
    setEditor(mountedEditor);
    setMonacoApi(monaco);
  }, []);
  const handleEditorChange = useCallback<OnChange>((value) => {
    setCode(value ?? "");
  }, []);

  const toggleStdin = useCallback(() => setStdinOpen((open) => !open), []);

  // Side by side there is nothing legible to leave in a 36px-wide column, so the
  // output collapses to nothing and borrows the editor's strip for its restore
  // button. Stacked, it collapses to its own tab strip and keeps it.
  const outputFullyHidden = layout.outputCollapsed && layout.orientation === "horizontal";

  // Save is off only for a room whose single file is empty. With more than one
  // file there is always an archive worth producing, and `handleSave` still
  // refuses an empty single file if the shortcut gets here first.
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

      {/* ── ONE Group, whose `orientation` is a prop. ────────────────────────
          Never two Groups behind a ternary, and never a `key` on anything
          between here and `EditorPane`. `useCollabRoom`'s master effect is keyed
          on the Monaco instance, so remounting the editor destroys the Y.Doc,
          the provider, the awareness handler and every MonacoBinding — wiping
          the room's shared output for everyone and re-firing every join toast.

          Verified against react-resizable-panels@4.12.2's own source: `Group`
          and `Panel` both render `children` unconditionally, `orientation` only
          flips the container's flex-direction, and collapsing a Panel changes
          nothing but inline flex-grow/flex-basis. Nothing here can unmount
          Monaco — and neither can switching files, which is a `path` prop and
          not a remount (see `EditorPane`'s fourth rule). */}
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

      {identity.status === "absent" && <JoinRoomPrompt />}
    </div>
  );
}
