"use client";

// Monaco, and nothing else.
//
// THREE RULES, and breaking any of them destroys the collaborative session:
//
//   1. This component must never be given a `key` that changes.
//   2. It must never be conditionally rendered (`{active && <EditorPane/>}`).
//   3. It must never move between parents in the tree.
//
// `useCollabRoom`'s master effect is keyed on the Monaco instance, so remounting
// `<Editor>` tears down the Y.Doc, the WebsocketProvider, the awareness handler
// and the MonacoBinding — wiping the room's shared output for everyone, re-firing
// every join toast, and orphaning y-monaco's cursor decorations. Hiding a pane is
// done by resizing its panel to zero, never by unmounting this.
//
// `memo` plus stable `onMount`/`onChange` callbacks from `CodeEditor` is what
// keeps a keystroke (which calls `setCode` and re-renders `CodeEditor`) from
// re-rendering the editor subtree. Nothing derived from `code` may be passed in
// here — see `CodeEditor`'s note about `handleRun`.
//
// FOURTH RULE, added by §10.1: switching files is done with the `path` prop and
// with nothing else. Verified against @monaco-editor/react@4.7's source — when
// `path` changes it resolves `editor.getModel(Uri.parse(path))`, creates the
// model if it is new, saves the outgoing view state and calls
// `editor.setModel(...)`. The editor instance is untouched and `onMount` does not
// re-fire, so the whole Yjs stack survives a tab switch. A `key` on this
// component, or one `<EditorPane>` per file behind a ternary, would each do
// exactly what the three rules above forbid.

import { memo, useMemo } from "react";
import Editor, { type BeforeMount, type OnChange, type OnMount } from "@monaco-editor/react";
import { MONACO_DARK, MONACO_LIGHT, defineMonacoThemes } from "../lib/monacoThemes";
import { useTheme } from "./ThemeProvider";

// Module scope, so the prop identity is stable across renders.
const registerThemes: BeforeMount = (monaco) => defineMonacoThemes(monaco);

const BASE_OPTIONS = {
  minimap: { enabled: false },
  // What makes every resize work with no `editor.layout()` call anywhere: Monaco
  // re-measures itself from its own ResizeObserver.
  automaticLayout: true,
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 12 },
  smoothScrolling: true,
  roundedSelection: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
} as const;

type EditorPaneProps = {
  language: string;
  /**
   * The active file's Monaco model URI (`modelPathFor` in `lib/roomFiles.ts`).
   * Undefined only before the first sync, when the room has no files yet.
   */
  path: string | undefined;
  onMount: OnMount;
  onChange: OnChange;
  /** Phone-sized viewport: wrap lines and grow the text to a tappable size. */
  compact: boolean;
};

function EditorPane({ language, path, onMount, onChange, compact }: EditorPaneProps) {
  const { resolved } = useTheme();

  // Memoised because `@monaco-editor/react` calls `editor.updateOptions()` on
  // every change of identity; a fresh object each render would reconfigure the
  // editor on every render for no reason.
  const options = useMemo(
    () => ({
      ...BASE_OPTIONS,
      fontSize: compact ? 13 : 14,
      // Off on a desktop, as any code editor should be. On a phone a horizontal
      // scrollbar inside a vertical scroll container is close to unusable.
      wordWrap: compact ? ("on" as const) : ("off" as const),
    }),
    [compact],
  );

  return (
    <Editor
      height="100%"
      language={language}
      // The one control that changes which file is on screen. `useCollabRoom`
      // owns the model for this URI and has a `MonacoBinding` attached to it
      // already, so the switch is instant and the text is never re-fetched.
      path={path}
      // No defaultValue: MonacoBinding resets the model to the Y.Text as soon as
      // it attaches, so content comes from the sync-gated seed.
      theme={resolved === "dark" ? MONACO_DARK : MONACO_LIGHT}
      beforeMount={registerThemes}
      onMount={onMount}
      onChange={onChange}
      options={options}
    />
  );
}

export default memo(EditorPane);
