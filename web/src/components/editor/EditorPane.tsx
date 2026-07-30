"use client";

// INVARIANT: never remount this (no changing `key`, no conditional render, no
// new parent) and pass nothing derived from `code`; switch files via `path` only.

import { memo, useMemo } from "react";
import Editor, { type BeforeMount, type OnChange, type OnMount } from "@monaco-editor/react";
import { MONACO_DARK, MONACO_LIGHT, defineMonacoThemes } from "@/lib/editor/monacoThemes";
import { useTheme } from "@/components/layout/ThemeProvider";

// Module scope, so the prop identity is stable across renders.
const registerThemes: BeforeMount = (monaco) => defineMonacoThemes(monaco);

const BASE_OPTIONS = {
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 12 },
  smoothScrolling: true,
  roundedSelection: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
} as const;

type EditorPaneProps = {
  language: string;
  /** The active file's Monaco model URI; undefined only before the first sync. */
  path: string | undefined;
  onMount: OnMount;
  onChange: OnChange;
  compact: boolean;
};

function EditorPane({ language, path, onMount, onChange, compact }: EditorPaneProps) {
  const { resolved } = useTheme();

  // A fresh object identity re-runs `editor.updateOptions()` on every render.
  const options = useMemo(
    () => ({
      ...BASE_OPTIONS,
      fontSize: compact ? 13 : 14,
      wordWrap: compact ? ("on" as const) : ("off" as const),
    }),
    [compact],
  );

  return (
    <Editor
      height="100%"
      language={language}
      path={path}
      // INVARIANT: no defaultValue — MonacoBinding resets the model to the Y.Text.
      theme={resolved === "dark" ? MONACO_DARK : MONACO_LIGHT}
      beforeMount={registerThemes}
      onMount={onMount}
      onChange={onChange}
      options={options}
    />
  );
}

export default memo(EditorPane);
