"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "@/components/ui/icons";
import { useTheme } from "./ThemeProvider";
import { cn, focusRing } from "@/lib/ui";
import type { Theme } from "@/lib/theme";

const OPTIONS: Array<{ value: Theme; label: string; Icon: (p: { className?: string }) => React.ReactElement }> = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
];

export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    // `radiogroup`, not a row of buttons: three mutually exclusive states.
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
