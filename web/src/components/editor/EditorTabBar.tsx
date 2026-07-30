"use client";

// Presentational: every filename here has already been sanitized by
// `readRoomFiles` (`lib/collab/roomFiles.ts`) — peer-supplied input.

import { useEffect, useRef, useState } from "react";
import FileTabMenu, { type FileTabMenuAction } from "./FileTabMenu";
import { PanelActions, PanelStrip } from "./PanelStrip";
import { MoreIcon, PlusIcon, StarIcon } from "@/components/ui/icons";
import { MAX_FILES, type RoomFile } from "@/lib/collab/roomFiles";
import { cn, focusRing } from "@/lib/ui";

type MenuState = { fileId: string; x: number; y: number };

type EditState = { kind: "rename"; fileId: string } | { kind: "create" } | null;

type EditorTabBarProps = {
  files: RoomFile[];
  activeFileId: string | null;
  entryFileId: string | null;
  onSelect: (fileId: string) => void;
  onCreate: (name?: string) => void;
  onRename: (fileId: string, name: string) => void;
  onDelete: (fileId: string) => void;
  onSetEntry: (fileId: string) => void;
  onDownload: (fileId: string) => void;
  actions?: React.ReactNode;
};

function NameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter commits then unmounts this input; a trailing `blur` would commit twice.
  const committedRef = useRef(false);
  const commitOnce = (value: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the stem, keep the extension.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  return (
    <input
      ref={inputRef}
      defaultValue={initial}
      aria-label="File name"
      spellCheck={false}
      onKeyDown={(event) => {
        // INVARIANT: keep — stops Monaco-bound shortcuts firing while naming.
        event.stopPropagation();
        if (event.key === "Enter") commitOnce(event.currentTarget.value);
        else if (event.key === "Escape") {
          committedRef.current = true;
          onCancel();
        }
      }}
      onBlur={(event) => commitOnce(event.currentTarget.value)}
      className={cn(
        "w-36 rounded border border-accent bg-raised px-2 py-0.5 font-mono text-xs text-fg outline-none",
      )}
    />
  );
}

export default function EditorTabBar({
  files,
  activeFileId,
  entryFileId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSetEntry,
  onDownload,
  actions,
}: EditorTabBarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<EditState>(null);

  const atLimit = files.length >= MAX_FILES;

  const handleMenuSelect = (fileId: string, action: FileTabMenuAction) => {
    setMenu(null);
    if (action === "entry") onSetEntry(fileId);
    else if (action === "rename") setEditing({ kind: "rename", fileId });
    else if (action === "download") onDownload(fileId);
    else onDelete(fileId);
  };

  const menuFile = menu ? files.find((file) => file.id === menu.fileId) : undefined;

  return (
    <PanelStrip>
      <div
        role="tablist"
        aria-label="Files in this room"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {files.map((file) => {
          const isActive = file.id === activeFileId;
          const isEntry = file.id === entryFileId;

          if (editing?.kind === "rename" && editing.fileId === file.id) {
            return (
              <div
                key={file.id}
                className="flex shrink-0 items-center border-r border-edge bg-code px-2"
              >
                <NameInput
                  initial={file.name}
                  onCommit={(value) => {
                    setEditing(null);
                    if (value.trim() && value !== file.name) onRename(file.id, value);
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            );
          }

          return (
            <div
              key={file.id}
              className={cn(
                "group relative flex shrink-0 items-center gap-1.5 border-r border-edge pl-3 pr-1.5 text-xs",
                isActive
                  ? "bg-code text-fg shadow-[inset_0_1.5px_0_0_var(--accent)]"
                  : "bg-panel text-fg-muted hover:bg-raised hover:text-fg",
              )}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ fileId: file.id, x: event.clientX, y: event.clientY });
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelect(file.id)}
                onDoubleClick={() => setEditing({ kind: "rename", fileId: file.id })}
                title={isEntry ? `${file.name} — Run executes this file` : file.name}
                className={cn("flex min-w-0 items-center gap-1.5 py-2 font-mono", focusRing)}
              >
                {isEntry && (
                  <StarIcon filled className="h-3 w-3 shrink-0 text-warning" />
                )}
                <span className="truncate">{file.name}</span>
              </button>

              <button
                type="button"
                aria-label={`File options for ${file.name}`}
                aria-haspopup="menu"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ fileId: file.id, x: rect.left, y: rect.bottom + 4 });
                }}
                className={cn(
                  "grid h-5 w-5 shrink-0 place-items-center rounded text-fg-subtle",
                  "opacity-0 transition-opacity hover:bg-edge hover:text-fg",
                  // `opacity-0` stays focusable; never swap it for `hidden`.
                  "group-hover:opacity-100 focus-visible:opacity-100",
                  isActive && "opacity-60",
                  focusRing,
                )}
              >
                <MoreIcon className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {editing?.kind === "create" && (
          <div className="flex shrink-0 items-center border-r border-edge bg-code px-2">
            <NameInput
              initial=""
              onCommit={(value) => {
                setEditing(null);
                // An empty commit still creates one, under the suggested name.
                onCreate(value.trim() || undefined);
              }}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}

        <button
          type="button"
          onClick={() => setEditing({ kind: "create" })}
          disabled={atLimit || editing !== null}
          aria-label="New file"
          title={atLimit ? `A room can hold ${MAX_FILES} files` : "New file"}
          className={cn(
            "grid w-8 shrink-0 place-items-center border-r border-edge text-fg-subtle",
            "transition-colors hover:bg-raised hover:text-fg",
            "disabled:cursor-not-allowed disabled:text-fg-subtle disabled:hover:bg-transparent",
            focusRing,
          )}
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {actions && <PanelActions>{actions}</PanelActions>}

      {menu && menuFile && (
        <FileTabMenu
          filename={menuFile.name}
          x={menu.x}
          y={menu.y}
          isEntry={menuFile.id === entryFileId}
          canDelete={files.length > 1}
          onSelect={(action) => handleMenuSelect(menuFile.id, action)}
          onClose={() => setMenu(null)}
        />
      )}
    </PanelStrip>
  );
}
