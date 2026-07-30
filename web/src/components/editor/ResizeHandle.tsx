"use client";

// INVARIANT: `Separator` (react-resizable-panels v4) owns the a11y contract, the drag
// cursor and the inflated hit rect — never reimplement any of it here. Drag state arrives
// as `data-separator`: inactive | hover | active | focus | disabled (v4 API, not v2/v3).

import { Separator } from "react-resizable-panels";
import type { Orientation } from "@/hooks/useRoomLayout";
import { cn } from "@/lib/ui";

export default function ResizeHandle({ orientation }: { orientation: Orientation }) {
  // Stacked panels are divided by a horizontal bar, and vice versa.
  const stacked = orientation === "vertical";

  return (
    <Separator
      className={cn(
        "group relative flex items-center justify-center bg-edge transition-colors focus-visible:outline-none",
        "data-[separator=hover]:bg-accent/70 data-[separator=focus]:bg-accent data-[separator=active]:bg-accent",
        stacked ? "h-px w-full" : "h-full w-px",
      )}
    >
      {/* Decorative grip; the real target is the library's inflated hit rect. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none rounded-full bg-fg-subtle opacity-0 transition-opacity",
          "group-data-[separator=hover]:opacity-100 group-data-[separator=focus]:opacity-100",
          "group-data-[separator=active]:opacity-100",
          stacked ? "h-0.5 w-8" : "h-8 w-0.5",
        )}
      />
    </Separator>
  );
}
