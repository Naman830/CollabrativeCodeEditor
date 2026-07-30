"use client";

// One file tab's menu (tasks.md §10.1): set as entry file, rename, download this
// file only, delete.
//
// §10.1 asks for it on right-click. Right-click *alone* would put four actions
// behind a gesture no keyboard and no touchscreen has, so the same menu is also
// opened by a kebab button on the tab — the context menu is the shortcut, the
// button is the affordance.
//
// Presentational: it knows which items to grey out and nothing about Yjs.

import { useEffect, useId, useRef } from "react";
import { DownloadIcon, StarIcon, TrashIcon, PencilIcon } from "./icons";
import { cn, focusRing } from "../lib/ui";

export type FileTabMenuAction = "entry" | "rename" | "download" | "delete";

type FileTabMenuProps = {
  filename: string;
  /** Viewport coordinates of the pointer, or of the kebab button. */
  x: number;
  y: number;
  isEntry: boolean;
  /** False for the room's only file — see `deleteFile` in `useCollabRoom`. */
  canDelete: boolean;
  onSelect: (action: FileTabMenuAction) => void;
  onClose: () => void;
};

/** Roughly the rendered size, used only to keep the menu inside the viewport. */
const MENU_WIDTH = 208;
const MENU_HEIGHT = 168;

export default function FileTabMenu({
  filename,
  x,
  y,
  isEntry,
  canDelete,
  onSelect,
  onClose,
}: FileTabMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  // Focus the menu itself so Escape reaches it and Tab leaves it, rather than
  // leaving focus on the tab behind an open popup.
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // `pointerdown`, not `click`: a click listener added during the click that
    // opened the menu would fire on that very same event and close it again.
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    // A scroll or resize moves the tab out from under a menu anchored to
    // viewport coordinates, so close rather than follow.
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8));

  const item = cn(
    "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-fg",
    "transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:text-fg-subtle disabled:hover:bg-transparent",
    focusRing,
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-labelledby={labelId}
      tabIndex={-1}
      style={{ left, top }}
      className="fixed z-50 w-52 overflow-hidden rounded-xl border border-edge bg-panel py-1 shadow-xl shadow-[var(--shadow-color)] outline-none"
    >
      <p
        id={labelId}
        className="truncate px-3 pb-1 pt-0.5 font-mono text-[11px] text-fg-subtle"
      >
        {filename}
      </p>

      <button
        type="button"
        role="menuitem"
        className={item}
        disabled={isEntry}
        title={
          isEntry
            ? "This is already the file Run executes"
            : "Run will execute this file for everyone in the room"
        }
        onClick={() => onSelect("entry")}
      >
        <StarIcon className="h-3.5 w-3.5 shrink-0" filled={isEntry} />
        {isEntry ? "Entry file" : "Set as entry file"}
      </button>

      <button type="button" role="menuitem" className={item} onClick={() => onSelect("rename")}>
        <PencilIcon className="h-3.5 w-3.5 shrink-0" />
        Rename…
      </button>

      <button type="button" role="menuitem" className={item} onClick={() => onSelect("download")}>
        <DownloadIcon className="h-3.5 w-3.5 shrink-0" />
        Download this file
      </button>

      <div aria-hidden className="my-1 h-px bg-edge" />

      <button
        type="button"
        role="menuitem"
        className={cn(item, "text-danger hover:bg-danger-soft")}
        disabled={!canDelete}
        title={canDelete ? undefined : "A room must keep at least one file"}
        onClick={() => onSelect("delete")}
      >
        <TrashIcon className="h-3.5 w-3.5 shrink-0" />
        Delete
      </button>
    </div>
  );
}
