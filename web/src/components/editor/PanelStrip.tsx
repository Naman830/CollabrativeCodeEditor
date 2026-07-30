"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing } from "@/lib/ui";

/** INVARIANT: the output `Panel`'s `collapsedSize` must equal this, or collapsing hides its own restore button. */
export const PANEL_STRIP_HEIGHT = "2.25rem";

export function PanelStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-edge bg-panel pr-1.5">
      {children}
    </div>
  );
}

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

/** `label` is both the accessible name and the tooltip; these buttons carry no visible text. */
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

export function PanelActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex min-w-0 items-center gap-1.5 self-center">{children}</div>;
}
