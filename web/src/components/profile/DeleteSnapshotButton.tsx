"use client";

// Belongs on the detail page, never on `DeadRoomCard` — a card is one `<Link>`, and a
// button inside an anchor is invalid.

import { startTransition, useActionState, useState } from "react";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { TrashIcon } from "@/components/ui/icons";
import { deleteSnapshotAction, type DeleteSnapshotResult } from "@/app/profile/actions";
import { cn, dangerButton, focusRing } from "@/lib/ui";

export default function DeleteSnapshotButton({
  deadRoomId,
  roomId,
}: {
  deadRoomId: string;
  roomId: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, formAction, pending] = useActionState<DeleteSnapshotResult | null, FormData>(
    deleteSnapshotAction,
    null,
  );

  // The action redirects on success and never returns, so any result here is a failure.
  const error = result?.ok === false ? result.message : null;

  const confirm = () => {
    const formData = new FormData();
    formData.set("deadRoomId", deadRoomId);
    startTransition(() => formAction(formData));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Remove this snapshot from your profile"
        className={cn(
          "flex items-center gap-1.5 rounded-lg border border-edge bg-transparent px-3 py-1.5",
          "text-xs font-medium text-fg-muted transition-colors",
          "hover:border-danger/50 hover:bg-danger-soft hover:text-danger",
          focusRing,
        )}
      >
        <TrashIcon className="h-3.5 w-3.5" />
        Delete
      </button>

      {open && (
        <ConfirmDialog
          title="Delete this snapshot?"
          confirmLabel={pending ? "Deleting…" : "Delete"}
          confirmClassName={dangerButton}
          busy={pending}
          error={error}
          onConfirm={confirm}
          onCancel={() => setOpen(false)}
        >
          <p>
            <span className="font-mono text-fg">{roomId}</span> will be removed from your
            profile. This cannot be undone, and there is no other copy — the live room was
            destroyed when the last person left.
          </p>
          <p className="mt-2 text-xs text-fg-subtle">
            Anyone else who worked in this room keeps their own copy.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
