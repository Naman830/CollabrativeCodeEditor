"use client";

// Ctrl/Cmd+Enter to run and Ctrl/Cmd+S to save, bound to the Monaco instance
// (tasks.md §10.5).
//
// Ctrl+S is the one that matters: inside a code editor it currently opens the
// *browser's* "save page" dialog, which is a live wrong behaviour rather than a
// missing feature. Monaco calls `preventDefault` for a keybinding it owns, so
// registering the action is also what suppresses that dialog.
//
// **Bindings live on the editor, never on `window`.** A global keydown handler
// would fire Run while someone is typing in the language select, in the stdin
// box, or (once §10.2 lands) in the chat box. The cost of that rule is that the
// suppression only holds while the editor has focus; the stdin textarea carries
// its own element-scoped handler in `CodeEditor` for exactly that reason.

import { useEffect, useRef } from "react";
import type { MonacoApi, MonacoEditor } from "@/lib/monacoTypes";

type UseEditorShortcutsOptions = {
  /** Null until Monaco has mounted. */
  editor: MonacoEditor | null;
  /** The namespace from `onMount`'s second argument; null until then. */
  monaco: MonacoApi | null;
  onRun: () => void;
  onSave: () => void;
};

export function useEditorShortcuts({
  editor,
  monaco,
  onRun,
  onSave,
}: UseEditorShortcutsOptions): void {
  // Both handlers close over `code`, so they are new functions on every
  // keystroke. Depending on them directly would tear down and re-register the
  // keybindings sixty times a minute; reading them through a ref registers
  // once. Same pattern `useCollabRoom` uses for `onRoomClosed` and `getToken`.
  const onRunRef = useRef(onRun);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onRunRef.current = onRun;
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    if (!editor || !monaco) return;

    // `addAction`, not `addCommand`: it returns an `IDisposable` (so this can be
    // torn down cleanly) and it also lists both actions in Monaco's F1 command
    // palette, which is free discoverability.
    //
    // Neither action re-checks the room-wide "running" lock, and neither should:
    // `useCodeRunner` already returns early when the shared execution map reads
    // "running", so the shortcut inherits exactly the same guard as the button
    // rather than keeping a second copy of it that could drift.
    const runAction = editor.addAction({
      id: "collab.run",
      label: "Run code",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        onRunRef.current();
      },
    });

    const saveAction = editor.addAction({
      id: "collab.save",
      label: "Save file (download)",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        onSaveRef.current();
      },
    });

    return () => {
      runAction.dispose();
      saveAction.dispose();
    };
  }, [editor, monaco]);
}
