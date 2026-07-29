"use client";

// The strip above the editor: one file tab, which doubles as the language
// selector.
//
// The filename *is* derived from the language (`downloadFileName`), so making
// the tab the control that changes it keeps one idea in one place — picking
// "Python" and seeing the tab become `main.py` is the same gesture. It also buys
// back the width the selector used to occupy in the chrome bar.
//
// A real `<select>` is layered invisibly over the tab rather than a custom
// popup: it keeps the native picker on mobile, the full keyboard contract, and
// screen-reader semantics for free. The visible row is `aria-hidden` decoration.

import { PanelActions, PanelStrip, PanelTab } from "./PanelStrip";
import { ChevronDownIcon, FileCodeIcon } from "./icons";
import { LANGUAGES, downloadFileName } from "../lib/languages";
import { cn } from "../lib/ui";

type EditorTabBarProps = {
  /** A per-user editing preference — never shared state. */
  language: string;
  onLanguageChange: (language: string) => void;
  /** Right-hand controls. Carries the output panel's restore button when the
   *  output is collapsed side-by-side and has no visible strip of its own. */
  actions?: React.ReactNode;
};

export default function EditorTabBar({
  language,
  onLanguageChange,
  actions,
}: EditorTabBarProps) {
  return (
    <PanelStrip>
      <PanelTab
        icon={<FileCodeIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />}
        className="focus-within:ring-2 focus-within:ring-inset focus-within:ring-accent/45"
      >
        <span aria-hidden className="truncate font-mono">
          {downloadFileName(language)}
        </span>
        <ChevronDownIcon className="h-3 w-3 shrink-0 text-fg-subtle" />
        <select
          aria-label="Language"
          title="Change language"
          value={language}
          onChange={(event) => onLanguageChange(event.target.value)}
          className={cn("absolute inset-0 cursor-pointer opacity-0 outline-none")}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </PanelTab>

      {actions && <PanelActions>{actions}</PanelActions>}
    </PanelStrip>
  );
}
