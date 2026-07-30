// Modifier-key *labels* only — Monaco's `KeyMod.CtrlCmd` already picks the key.

export function isAppleKeyboard(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function modKeyLabel(): string {
  return isAppleKeyboard() ? "⌘" : "Ctrl";
}

export function shortcutLabel(key: string): string {
  return `${modKeyLabel()}+${key}`;
}
