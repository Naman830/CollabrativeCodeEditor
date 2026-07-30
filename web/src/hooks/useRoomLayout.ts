"use client";

// INVARIANT: nothing here may re-render `CodeEditor` mid-drag — only
// `onLayoutChanged` (on release) is wired up, and sizes live in a ref, not state.

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Layout, PanelImperativeHandle } from "react-resizable-panels";

export type Orientation = "horizontal" | "vertical";

export const EDITOR_PANEL_ID = "editor";
export const OUTPUT_PANEL_ID = "output";

const STORAGE_KEY = "collabcode:room-layout:v1";

/** Below this the stack is forced and the orientation control is not offered. */
const NARROW_QUERY = "(max-width: 767px)";

const DEFAULT_EDITOR_PCT = 62;

type Persisted = {
  /** The user's *choice*, never the phone's forced stack. */
  orientation: Orientation;
  editorPct: number;
  outputCollapsed: boolean;
};

const FALLBACK: Persisted = {
  orientation: "horizontal",
  editorPct: DEFAULT_EDITOR_PCT,
  outputCollapsed: false,
};

// INVARIANT: never throws — localStorage itself can, and the stored value is
// user-editable, so anything unparseable must degrade to FALLBACK.
function readPersisted(): Persisted {
  if (typeof window === "undefined") return FALLBACK;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return FALLBACK;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const pct = parsed.editorPct;
    return {
      orientation: parsed.orientation === "vertical" ? "vertical" : "horizontal",
      editorPct: typeof pct === "number" && pct >= 15 && pct <= 85 ? pct : DEFAULT_EDITOR_PCT,
      outputCollapsed: parsed.outputCollapsed === true,
    };
  } catch {
    return FALLBACK;
  }
}

// INVARIANT: module scope keeps `subscribeNarrow` referentially stable, or
// `useSyncExternalStore` resubscribes on every render.

function subscribeNarrow(onChange: () => void): () => void {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

function getNarrowServer(): boolean {
  return false;
}

export type RoomLayout = {
  orientation: Orientation;
  isNarrow: boolean;
  canToggleOrientation: boolean;
  toggleOrientation: () => void;
  outputCollapsed: boolean;
  toggleOutput: () => void;
  defaultLayout: Layout;
  handleLayoutChanged: (layout: Layout) => void;
  outputPanelRef: React.RefObject<PanelImperativeHandle | null>;
};

export function useRoomLayout(): RoomLayout {
  const [initial] = useState(readPersisted);

  const [preferred, setPreferred] = useState<Orientation>(initial.orientation);
  const [outputCollapsed, setOutputCollapsed] = useState(initial.outputCollapsed);

  const isNarrow = useSyncExternalStore(subscribeNarrow, getNarrow, getNarrowServer);

  // Narrow is always stacked, but the stored *preference* is left untouched.
  const orientation: Orientation = isNarrow ? "vertical" : preferred;

  const outputPanelRef = useRef<PanelImperativeHandle | null>(null);

  const editorPctRef = useRef(initial.editorPct);

  // Last-written record, so one atomic write covers the fields a patch omits.
  const persistedRef = useRef(initial);

  const persist = useCallback((patch: Partial<Persisted>) => {
    persistedRef.current = {
      ...persistedRef.current,
      ...patch,
      editorPct: editorPctRef.current,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedRef.current));
    } catch {
      // Quota or private mode; a forgotten layout is not worth throwing.
    }
  }, []);

  const toggleOrientation = useCallback(() => {
    setPreferred((prev) => {
      const next = prev === "horizontal" ? "vertical" : "horizontal";
      persist({ orientation: next });
      return next;
    });
  }, [persist]);

  const toggleOutput = useCallback(() => {
    const panel = outputPanelRef.current;
    if (!panel) return;
    // The panel is the authority on its own collapsed-ness (dragging collapses too).
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, []);

  const handleLayoutChanged = useCallback(
    (layout: Layout) => {
      const collapsed = outputPanelRef.current?.isCollapsed() ?? false;
      setOutputCollapsed(collapsed);
      if (!collapsed) {
        const pct = layout[EDITOR_PANEL_ID];
        if (typeof pct === "number") editorPctRef.current = pct;
      }
      persist({ outputCollapsed: collapsed });
    },
    [persist],
  );

  const defaultLayout = useMemo<Layout>(
    () => ({
      [EDITOR_PANEL_ID]: initial.editorPct,
      [OUTPUT_PANEL_ID]: 100 - initial.editorPct,
    }),
    [initial.editorPct],
  );

  return {
    orientation,
    isNarrow,
    canToggleOrientation: !isNarrow,
    toggleOrientation,
    outputCollapsed,
    toggleOutput,
    defaultLayout,
    handleLayoutChanged,
    outputPanelRef,
  };
}
