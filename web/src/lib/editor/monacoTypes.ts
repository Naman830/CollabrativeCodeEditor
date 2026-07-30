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
 * `lib/editor/monacoLoader.ts`).
 */
export type MonacoApi = Parameters<OnMount>[1];

/**
 * One text model. §10.1 gives a room one per file, created through `MonacoApi`
 * rather than imported, so this is derived from the namespace for the same
 * `window`-at-import-time reason as the two types above.
 */
export type MonacoModel = NonNullable<ReturnType<MonacoEditor["getModel"]>>;
