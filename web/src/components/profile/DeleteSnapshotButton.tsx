"use client";

// "Remove from my profile" on a snapshot's detail page (tasks.md §10.7).
//
// The second client component under `/profile`, after `SnapshotActions` — which
// is the budget §10.7 sets ("must not become the page's second reason to ship
// client JavaScript beyond the confirm dialog"). The delete itself is a Server
// Function; everything here is the confirmation around it.
//
// It lives on the detail page, not on `DeadRoomCard`: a card's entire surface is
// one `<Link>`, and a button nested inside an anchor is invalid.

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
  /** The original room id, shown so the confirmation names what is going. */
  roomId: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, formAction, pending] = useActionState<DeleteSnapshotResult | null, FormData>(
    deleteSnapshotAction,
    null,
  );

  // On success the action redirects and never returns, so anything here is a
  // failure worth showing inside the dialog rather than throwing the user into
  // `error.tsx`, whose copy is about a failed *read*.
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
