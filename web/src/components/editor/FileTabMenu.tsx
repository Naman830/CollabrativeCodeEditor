"use client";


import { useEffect, useId, useRef } from "react";
import { DownloadIcon, StarIcon, TrashIcon, PencilIcon } from "@/components/ui/icons";
import { cn, focusRing } from "@/lib/ui";

export type FileTabMenuAction = "entry" | "rename" | "download" | "delete";

type FileTabMenuProps = {
  filename: string;
  /** Viewport coordinates of the pointer, or of the kebab button. */
  x: number;
  y: number;
  isEntry: boolean;
  canDelete: boolean;
  onSelect: (action: FileTabMenuAction) => void;
  onClose: () => void;
};

/** Approximate rendered size, used only to keep the menu inside the viewport. */
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
  // Captured on mount so Escape can put focus back where it came from. Without this, closing
  // dropped focus to <body> and the next Tab restarted from the top of the page.
  const triggerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null,
  );

  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    );

  // INVARIANT: role="menu" promises a keyboard model, and this component declared the role while
  // implementing none of it — ArrowDown/Up/Home/End did nothing and focus parked on the container.
  useEffect(() => {
    // Focus the first item, not the container: a menu whose only reachable path is Tab is the
    // anti-pattern the role exists to avoid.
    const first = items()[0];
    if (first) first.focus();
    else menuRef.current?.focus();
  }, []);

  const restoreFocus = () => {
    const trigger = triggerRef.current;
    if (trigger && document.contains(trigger)) trigger.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const list = items();
    if (list.length === 0) return;
    const current = list.indexOf(document.activeElement as HTMLButtonElement);

    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };

    if (event.key === "ArrowDown") return move(current + 1);
    if (event.key === "ArrowUp") return move(current - 1);
    if (event.key === "Home") return move(0);
    if (event.key === "End") return move(list.length - 1);
    // A focus trap, so Tab cannot leave an open menu floating over the editor.
    if (event.key === "Tab") {
      event.preventDefault();
      move(event.shiftKey ? current - 1 : current + 1);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        restoreFocus();
        onClose();
      }
    };
    // `pointerdown`, not `click`: a click listener added here would fire on the
    // very event that opened the menu.
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    // Anchored to viewport coordinates, so close rather than follow.
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
      onKeyDown={onMenuKeyDown}
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
