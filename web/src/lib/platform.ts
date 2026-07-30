// Which modifier key to *name* in a tooltip. Nothing here changes behaviour —
// Monaco's `KeyMod.CtrlCmd` already resolves to ⌘ on macOS and Ctrl elsewhere,
// so this exists only so the Run and Save buttons can say which one (§10.5's
// "both shortcuts are discoverable").
//
// Safe to call during render *on this app's routes*: the only consumer is
// `RoomChrome`, which lives under `CodeEditor` and is therefore loaded through
// `dynamic(..., { ssr: false })` in `RoomGate`, so it never server-renders and
// there is no server/client mismatch to hydrate. The `typeof navigator` guard
// keeps it honest anyway, for any future caller that is server-rendered.

/**
 * `navigator.platform` is deprecated and `userAgentData` is Chromium-only, so
 * this reads the UA string — which is only ever used to pick a label.
 */
export function isAppleKeyboard(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** "⌘" on Apple keyboards, "Ctrl" everywhere else. */
export function modKeyLabel(): string {
  return isAppleKeyboard() ? "⌘" : "Ctrl";
}

/** e.g. "Ctrl+Enter" / "⌘+S". */
export function shortcutLabel(key: string): string {
  return `${modKeyLabel()}+${key}`;
}
