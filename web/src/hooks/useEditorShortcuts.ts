"use client";

// INVARIANT: bindings live on the editor, never on `window` — a global keydown
// handler would fire Run while someone types in the stdin box or a filename field.

import { useEffect, useRef } from "react";
import type { MonacoApi, MonacoEditor } from "@/lib/editor/monacoTypes";

type UseEditorShortcutsOptions = {
  editor: MonacoEditor | null;
  /** The namespace from `onMount`'s second argument, never a static import. */
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
  // Read through refs: the handlers are new on every keystroke, and depending on
  // them would re-register the keybindings sixty times a minute.
  const onRunRef = useRef(onRun);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onRunRef.current = onRun;
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    if (!editor || !monaco) return;

    // `addAction`, not `addCommand`: it returns an `IDisposable`. Neither action
    // re-checks the room-wide "running" lock — `useCodeRunner` owns that guard.
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
