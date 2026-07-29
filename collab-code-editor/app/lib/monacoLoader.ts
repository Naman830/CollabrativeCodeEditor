"use client";

// `@monaco-editor/react` defaults to fetching Monaco from a CDN with an AMD
// loader, which installs a global `define` carrying `define.amd`. That is not a
// private detail: any UMD bundle loaded afterwards sees `define.amd` and
// registers itself as an AMD module instead of executing. Clerk's UI bundle is
// one such script, so on the room route it failed with
// `failed_to_load_clerk_ui` and Clerk never finished loading — a signed-in user
// deep-linking into a room silently had no session, and therefore no
// `clerkUserId` (tasks.md 7.1 item 4 covers "created *or joined*").
//
// Verified by controlled experiment: on the very same `/room/[roomId]` route,
// a dead room ID — which makes `RoomGate` show the closed screen and never
// mount Monaco — resolved the Clerk user fine, while a live room did not.
// Because it is a race between two CDN fetches, it reproduced only sometimes.
//
// Pointing the loader at the `monaco-editor` package we already depend on means
// no AMD loader is ever installed, and Monaco stops being a runtime CDN
// dependency at the same time.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

let configured = false;

/** Idempotent: `loader.config` must run before the first <Editor> mounts. */
export function configureMonacoLoader(): void {
  if (configured) return;
  configured = true;
  loader.config({ monaco });
}
