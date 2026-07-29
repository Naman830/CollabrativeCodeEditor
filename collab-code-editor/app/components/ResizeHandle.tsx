"use client";

// The draggable divider between the editor and the output.
//
// `Separator` (react-resizable-panels v4) already ships the entire
// accessibility contract — `role="separator"`, `tabIndex=0`, `aria-controls`,
// `aria-valuenow/min/max`, arrow keys for ±5%, Home/End for full travel, Enter
// to collapse or expand a collapsible neighbour, F6 to cycle handles, and
// double-click to reset to the default size. So this file is paint, and nothing
// else.
//
// Two things the library owns that must NOT be reimplemented here:
//   * The cursor. It injects a global `*, *:hover { cursor: … !important }`
//     rule while dragging, so a `cursor-col-resize` class would be dead code.
//   * The hit target. `Group`'s `resizeTargetMinimumSize` inflates the hit rect
//     (28px coarse / 10px fine here), so a 1px line is already grabbable on a
//     touchscreen and needs no padding-span trick.
//
// Drag state arrives on the `data-separator` attribute, whose values are
// "inactive" | "hover" | "active" | "focus" | "disabled" — read out of the
// v4.12.2 bundle, not guessed. Note this is NOT the v2/v3 API: there is no
// `PanelResizeHandle` and no `data-resize-handle-state`.

import { Separator } from "react-resizable-panels";
import type { Orientation } from "../hooks/useRoomLayout";
import { cn } from "../lib/ui";

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
      {/* The grip. Purely decorative — the real target is the inflated hit rect
          above — so it appears only once the handle is hovered or focused,
          rather than drawing a permanent seam across the room. */}
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
