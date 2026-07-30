import type { OnMount } from "@monaco-editor/react";

// Derived from the mount callbacks, never `import "monaco-editor"` — that touches `window`.
export type MonacoEditor = Parameters<OnMount>[0];

export type MonacoApi = Parameters<OnMount>[1];

export type MonacoModel = NonNullable<ReturnType<MonacoEditor["getModel"]>>;
