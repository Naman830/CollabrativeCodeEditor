"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// How long the "copied" tick stays on the button before reverting.
const COPIED_RESET_MS = 1500;

/**
 * Copies a string and reports a transient `copied` flag for the button label.
 * The reset timer is a ref so cleanup can cancel it and never setState on an
 * unmounted component.
 */
export function useCopyToClipboard(): {
  copied: boolean;
  copy: (value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(async (value: string) => {
    try {
      // navigator.clipboard only exists in a secure context, so a room opened
      // over plain http on a LAN address (the usual way to test with a phone)
      // falls back to the old selection trick rather than throwing.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const scratch = document.createElement("textarea");
        scratch.value = value;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.opacity = "0";
        document.body.appendChild(scratch);
        scratch.select();
        document.execCommand("copy");
        document.body.removeChild(scratch);
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // Clipboard permission can still be denied outright; the value is visible
      // on screen either way, so there is nothing to report.
    }
  }, []);

  return { copied, copy };
}
