"use client";

// Where the editor/output split lives: which way the room is divided, how big
// each side is, whether the output is folded away, and whether the viewport is
// too narrow to offer the choice at all. One localStorage key holds all of it.
//
// The rule this file exists to enforce: **nothing here may re-render
// `CodeEditor` during a drag.** `Group` exposes two callbacks — `onLayoutChange`
// fires on every pointermove, `onLayoutChanged` fires once on release — and only
// the second is ever wired up. Sizes are kept in a ref rather than state for the
// same reason. `CodeEditor` renders the element that holds Monaco, and a
// re-render there hands `<Editor>` a fresh element, which is the one thing that
// can break `Panel`'s child-bailout and reach the editor mid-drag.
//
// Reading localStorage in a lazy initializer is safe here only because
// `RoomGate` loads `CodeEditor` with `ssr: false` — there is no server render
// for a restored ratio to disagree with. The `typeof window` guard is kept
// anyway, so the hook is correct on its own terms.

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Layout, PanelImperativeHandle } from "react-resizable-panels";

/** `horizontal` = side by side, `vertical` = stacked. Matches `Group`'s prop. */
export type Orientation = "horizontal" | "vertical";

/** Panel ids. Also the keys of every `Layout` this hook handles. */
export const EDITOR_PANEL_ID = "editor";
export const OUTPUT_PANEL_ID = "output";

const STORAGE_KEY = "collabcode:room-layout:v1";

/** Below this a side-by-side split leaves both halves too narrow to read code,
 *  so the stack is forced and the orientation control is not offered. */
const NARROW_QUERY = "(max-width: 767px)";

/** The editor's default share of the group. */
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

/**
 * Never throws. The try/catch is not decorative: `localStorage` access throws
 * outright in some Safari private-mode configurations, and the value is
 * user-editable, so a hand-mangled entry must degrade to defaults rather than
 * take the room down with it.
 */
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

/* --------------------------------------------------------- narrow-screen store */
// Module scope so `subscribe` is referentially stable across renders, which is
// what `useSyncExternalStore` needs to avoid resubscribing every time.

function subscribeNarrow(onChange: () => void): () => void {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

// Never actually reached (`ssr: false`), but kept correct. "Not narrow" is the
// safer guess: the phone layout is a strict subset of it — a forced stack — so
// being wrong costs one flex-direction, not a different tree.
function getNarrowServer(): boolean {
  return false;
}

export type RoomLayout = {
  /** What `Group` should use, after the narrow-screen override. */
  orientation: Orientation;
  /** Phone-sized viewport. Also drives Monaco's word-wrap and font size. */
  isNarrow: boolean;
  /** False on phones, where the stack is forced and the toggle would be a lie. */
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

  // A narrow viewport is always stacked, but the stored *preference* is left
  // alone, so rotating a tablet back to landscape restores the real choice.
  const orientation: Orientation = isNarrow ? "vertical" : preferred;

  const outputPanelRef = useRef<PanelImperativeHandle | null>(null);

  // Sizes live in a ref, not state — see the header comment. `handleLayoutChanged`
  // runs on every drag *release*; if it set state, every release would re-render
  // CodeEditor and with it the whole chrome bar.
  const editorPctRef = useRef(initial.editorPct);

  // The last-written record, so a patch never has to re-read storage to find the
  // fields it is not changing. One atomic write means orientation, size and
  // collapsed state can never disagree with each other on disk.
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
      // Quota, or Safari private mode. A forgotten layout is not worth throwing.
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
    // Drive the library and let `handleLayoutChanged` report the result back.
    // The panel is the authority on its own collapsed-ness, including when the
    // user collapses it by dragging the separator past `minSize` instead of
    // pressing this button.
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, []);

  const handleLayoutChanged = useCallback(
    (layout: Layout) => {
      const collapsed = outputPanelRef.current?.isCollapsed() ?? false;
      // React bails out on an unchanged value, so an ordinary drag release costs
      // zero renders. This fires after pointerup, never mid-drag.
      setOutputCollapsed(collapsed);
      if (!collapsed) {
        const pct = layout[EDITOR_PANEL_ID];
        if (typeof pct === "number") editorPctRef.current = pct;
      }
      persist({ outputCollapsed: collapsed });
    },
    [persist],
  );

  // Read once, on mount, so the first paint is already the restored ratio.
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
