// Monaco themes matching the app's own tokens. Typed off `BeforeMount`, never by importing
// `monaco-editor` — that module touches `window` at import time.

import type { BeforeMount } from "@monaco-editor/react";

type Monaco = Parameters<BeforeMount>[0];

export const MONACO_DARK = "collab-dark";
export const MONACO_LIGHT = "collab-light";

// Keep in sync with `--code-bg` and friends in `web/src/styles/globals.css`.
const DARK_COLORS: Record<string, string> = {
  "editor.background": "#0a0b0d",
  "editor.foreground": "#e8eaed",
  "editorGutter.background": "#0a0b0d",
  "editorLineNumber.foreground": "#3f4650",
  "editorLineNumber.activeForeground": "#9aa1ac",
  "editor.lineHighlightBackground": "#14171c",
  "editor.lineHighlightBorder": "#00000000",
  "editor.selectionBackground": "#4c8dff40",
  "editor.inactiveSelectionBackground": "#4c8dff20",
  "editorCursor.foreground": "#4c8dff",
  "editorIndentGuide.background1": "#1f232a",
  "editorIndentGuide.activeBackground1": "#333944",
  "editorWidget.background": "#131519",
  "editorWidget.border": "#24282f",
  "editorSuggestWidget.background": "#131519",
  "editorSuggestWidget.border": "#24282f",
  "scrollbarSlider.background": "#3a3a3a80",
  "scrollbarSlider.hoverBackground": "#4d4d4db0",
  "scrollbarSlider.activeBackground": "#4d4d4d",
};

const LIGHT_COLORS: Record<string, string> = {
  "editor.background": "#fbfcfd",
  "editor.foreground": "#14171c",
  "editorGutter.background": "#fbfcfd",
  "editorLineNumber.foreground": "#b4bbc5",
  "editorLineNumber.activeForeground": "#5a626e",
  "editor.lineHighlightBackground": "#f1f3f6",
  "editor.lineHighlightBorder": "#00000000",
  "editor.selectionBackground": "#2563eb26",
  "editor.inactiveSelectionBackground": "#2563eb14",
  "editorCursor.foreground": "#2563eb",
  "editorIndentGuide.background1": "#e8ebef",
  "editorIndentGuide.activeBackground1": "#cbd1da",
  "editorWidget.background": "#ffffff",
  "editorWidget.border": "#e2e5ea",
  "editorSuggestWidget.background": "#ffffff",
  "editorSuggestWidget.border": "#e2e5ea",
  "scrollbarSlider.background": "#c3c9d280",
  "scrollbarSlider.hoverBackground": "#a7aeb9b0",
  "scrollbarSlider.activeBackground": "#a7aeb9",
};

export function defineMonacoThemes(monaco: Monaco): void {
  monaco.editor.defineTheme(MONACO_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: DARK_COLORS,
  });
  monaco.editor.defineTheme(MONACO_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: LIGHT_COLORS,
  });
}
