import type { OnMount } from "@monaco-editor/react";

/**
 * The editor instance Monaco hands back on mount, typed without importing
 * monaco-editor itself (it touches `window` at import time).
 */
export type MonacoEditor = Parameters<OnMount>[0];
