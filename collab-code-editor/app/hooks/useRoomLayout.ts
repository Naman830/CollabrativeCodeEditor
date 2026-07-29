"use client";

// Which way the editor/output split runs, and whether the viewport is too narrow
// to offer the choice.
//
// Deliberately *not* the panel sizes: those are owned entirely by
// `react-resizable-panels`' own `autoSaveId` persistence. Holding them in React
// state instead would re-render `CodeEditor` — and therefore the whole Monaco
// subtree — on every animation frame of a drag.
//
// Both values are read through `useSyncExternalStore` for the same reason
// `lib/user.ts` and `components/ThemeProvider.tsx` are: the server cannot know
// either answer, and React 19's `react-hooks/set-state-in-effect` rule rejects
// the `useEffect(() => setState(read()))` shape that would otherwise be obvious.

import { useCallback, useSyncExternalStore } from "react";

/** `horizontal` = side by side, `vertical` = stacked. Matches PanelGroup's prop. */
export type Orientation = "horizontal" | "vertical";

const ORIENTATION_KEY = "collabcode:room-orientation";

/** Below this the two panels are stacked with no choice offered — side-by-side
 *  on a phone leaves both halves too narrow to read a line of code. */
const NARROW_QUERY = "(max-width: 767px)";

function isOrientation(value: unknown): value is Orientation {
  return value === "horizontal" || value === "vertical";
}

/* ---------------------------------------------------------------- orientation */

let orientation: Orientation | null = null;
const orientationListeners = new Set<() => void>();

function getOrientation(): Orientation {
  if (!orientation) {
    try {
      const stored = window.localStorage.getItem(ORIENTATION_KEY);
      orientation = isOrientation(stored) ? stored : "horizontal";
    } catch {
      orientation = "horizontal";
    }
  }
  return orientation;
}

function getServerOrientation(): Orientation {
  return "horizontal";
}

function subscribeOrientation(listener: () => void): () => void {
  orientationListeners.add(listener);
  return () => {
    orientationListeners.delete(listener);
  };
}

function writeOrientation(next: Orientation): void {
  orientation = next;
  try {
    window.localStorage.setItem(ORIENTATION_KEY, next);
  } catch {
    // Not remembering the layout is survivable.
  }
  orientationListeners.forEach((listener) => listener());
}

/* -------------------------------------------------------------- narrow screen */

let narrow: boolean | null = null;
let narrowQuery: MediaQueryList | null = null;
const narrowListeners = new Set<() => void>();

function getNarrow(): boolean {
  if (narrow === null) {
    narrow = window.matchMedia(NARROW_QUERY).matches;
  }
  return narrow;
}

function getServerNarrow(): boolean {
  return false;
}

function subscribeNarrow(listener: () => void): () => void {
  narrowListeners.add(listener);
  if (!narrowQuery) {
    narrowQuery = window.matchMedia(NARROW_QUERY);
    narrowQuery.addEventListener("change", (event) => {
      narrow = event.matches;
      narrowListeners.forEach((l) => l());
    });
  }
  return () => {
    narrowListeners.delete(listener);
  };
}

/* ---------------------------------------------------------------------- hook */

export type RoomLayout = {
  /** What PanelGroup should actually use, after the narrow-screen override. */
  orientation: Orientation;
  /** What the user picked, which is what the toggle button reflects. */
  preferred: Orientation;
  /** False on phones, where the split is forced to stacked. */
  canToggle: boolean;
  toggleOrientation: () => void;
};

export function useRoomLayout(): RoomLayout {
  const preferred = useSyncExternalStore(
    subscribeOrientation,
    getOrientation,
    getServerOrientation,
  );
  const isNarrow = useSyncExternalStore(subscribeNarrow, getNarrow, getServerNarrow);

  const toggleOrientation = useCallback(() => {
    writeOrientation(getOrientation() === "horizontal" ? "vertical" : "horizontal");
  }, []);

  return {
    orientation: isNarrow ? "vertical" : preferred,
    preferred,
    canToggle: !isNarrow,
    toggleOrientation,
  };
}
