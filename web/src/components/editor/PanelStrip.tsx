"use client";

// The strip at the top of a pane: a tab on the left, a control cluster on the
// right. One component for both the file tab above the editor and the Output tab
// above the results, so multi-file (tasks.md §10.1) and in-room chat (§10.2)
// become a data change here rather than a third piece of chrome.

import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing } from "@/lib/ui";

/**
 * The strip's height, as a CSS length.
 *
 * The output `Panel`'s `collapsedSize` is set to exactly this, so a collapsed
 * output panel *is* this strip and nothing else — a bar you can still see and
 * click to bring the output back. Change one and you must change the other, or
 * collapsing hides its own restore button.
 */
export const PANEL_STRIP_HEIGHT = "2.25rem";

export function PanelStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-edge bg-panel pr-1.5">
      {children}
    </div>
  );
}

/**
 * The tab itself. Styled to sit on the code surface below it rather than the
 * panel chrome, which is what makes it read as a tab and not a button.
 */
export function PanelTab({
  icon,
  children,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-2 border-r border-edge bg-code px-3 text-xs text-fg",
        "shadow-[inset_0_1.5px_0_0_var(--accent)]",
        className,
      )}
    >
      {icon}
      {children}
    </div>
  );
}

/** A 24px square control for a panel strip. `label` is both the accessible name
 *  and the tooltip; these buttons never carry visible text. */
export function IconButton({
  label,
  children,
  ...rest
}: { label: string; children: ReactNode } & Omit<
  ComponentProps<"button">,
  "className" | "children" | "type"
>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors",
        "hover:bg-raised hover:text-fg",
        focusRing,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The right-hand cluster of a strip. */
export function PanelActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex min-w-0 items-center gap-1.5 self-center">{children}</div>;
}
