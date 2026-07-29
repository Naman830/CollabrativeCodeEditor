"use client";

// A three-way segmented control rather than a two-way switch, because "system"
// is a real choice and a two-state toggle has nowhere to put it: once someone
// clicks a sun/moon they are pinned to that theme forever with no way back to
// following the OS.

import { MonitorIcon, MoonIcon, SunIcon } from "./icons";
import { useTheme } from "./ThemeProvider";
import { cn, focusRing } from "../lib/ui";
import type { Theme } from "../lib/theme";

const OPTIONS: Array<{ value: Theme; label: string; Icon: (p: { className?: string }) => React.ReactElement }> = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
];

export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    // `radiogroup` rather than a row of buttons: these are three mutually
    // exclusive states, and it gives screen readers "2 of 3" for free.
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-edge bg-raised/60 p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={`${label} theme`}
            onClick={() => setTheme(value)}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-md transition-colors",
              focusRing,
              active
                ? "bg-panel text-fg shadow-sm shadow-[var(--shadow-color)]"
                : "text-fg-subtle hover:text-fg-muted",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
