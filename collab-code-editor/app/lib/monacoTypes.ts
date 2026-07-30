import type { OnMount } from "@monaco-editor/react";

/**
 * The editor instance Monaco hands back on mount, typed without importing
 * monaco-editor itself (it touches `window` at import time).
 */
export type MonacoEditor = Parameters<OnMount>[0];

/**
 * The `monaco` namespace, as handed to `onMount`'s second argument.
 *
 * Taken from the callback rather than a static `import "monaco-editor"` for the
 * same reason as above — which is the only way `KeyMod`/`KeyCode` can be reached
 * from a module that must not touch `window` at import time (see §10.5 and
 * `lib/monacoLoader.ts`).
 */
export type MonacoApi = Parameters<OnMount>[1];
