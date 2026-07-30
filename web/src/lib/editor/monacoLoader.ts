"use client";

// INVARIANT: Monaco must come from the npm package, never `@monaco-editor/react`'s CDN AMD
// loader — its global `define.amd` makes Clerk's UMD bundle register instead of execute.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

let configured = false;

// INVARIANT: must run before the first <Editor> mounts.
export function configureMonacoLoader(): void {
  if (configured) return;
  configured = true;
  loader.config({ monaco });
}
