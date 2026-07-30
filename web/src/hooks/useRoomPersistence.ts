"use client";

// The two halves of tasks.md §10.8, together because they are one idea: warn the
// person whose tab close destroys the room, and tell them whether anything of it
// survives.
//
// Nothing here talks to the server. See `lib/data/persistence.ts` for why the answer
// is necessarily an estimate and why the wording promises less than the server
// guarantees.

import { useEffect, useRef, useState } from "react";
import type { SyncStatus } from "./useCollabRoom";
import type { Peer } from "@/lib/collab/awareness";
import { MEMBER_MIN_CONNECTED_MS, type PersistenceStatus } from "@/lib/data/persistence";
import type { CollabUser } from "@/lib/collab/user";

/** How often the countdown re-renders while one is running. */
const TICK_MS = 1_000;

type UseRoomPersistenceOptions = {
  peers: Peer[];
  syncStatus: SyncStatus;
  user: CollabUser | null;
  didEdit: boolean;
};

export type RoomPersistence = {
  status: PersistenceStatus;
  /** Milliseconds left before the connected-time threshold; 0 once met. */
  remainingMs: number;
  /** True when this client is the only one in the room. */
  isLastPeer: boolean;
};

export function useRoomPersistence({
  peers,
  syncStatus,
  user,
  didEdit,
}: UseRoomPersistenceOptions): RoomPersistence {
  const signedIn = Boolean(user?.clerkUserId);

  // `peers.length === 0` is NOT "alone" — it is the pre-connect and torn-down
  // state, before this client has even published its own awareness. Being the
  // last person means exactly one peer and it being you, which is the same
  // distinction `PresenceStack` draws with its `connected` prop.
  const isLastPeer =
    syncStatus === "connected" && peers.length === 1 && peers[0].isLocal === true;

  // ---------------------------------------------------------------------
  // Accumulated connected time.
  //
  // A rough analogue of the server's refcounted `elapsedMs`: time only accrues
  // while the socket is up, so a long disconnect does not quietly count toward
  // the threshold. It cannot match the server exactly (that one counts every
  // socket of the account, this one counts a tab), which is the point of the
  // estimate framing.
  // ---------------------------------------------------------------------
  // The refs are written and read only inside effects and timer callbacks, and
  // the value that drives rendering is state. React 19's `react-hooks/refs` and
  // `react-hooks/purity` rules reject the shorter version of this — a
  // `Date.now()` and a `ref.current` read during render — and they are right to:
  // a value that changes without a render is exactly what must not be rendered.
  const accumulatedRef = useRef(0);
  const sinceRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (syncStatus === "connected") {
      if (sinceRef.current === null) sinceRef.current = Date.now();
      return;
    }
    if (sinceRef.current !== null) {
      accumulatedRef.current += Date.now() - sinceRef.current;
      sinceRef.current = null;
    }
  }, [syncStatus]);

  const thresholdMet = elapsedMs >= MEMBER_MIN_CONNECTED_MS;

  // Tick only while a countdown is actually on screen, and stop the moment the
  // threshold is met. Bounded at ~60 ticks per session, so this never becomes a
  // permanent once-a-second re-render of the room. (`EditorPane` is memo'd, so
  // Monaco is untouched either way — but the output panel is not.)
  const counting = signedIn && didEdit && !thresholdMet && syncStatus === "connected";
  useEffect(() => {
    if (!counting) return;
    const update = () => {
      setElapsedMs(
        accumulatedRef.current +
          (sinceRef.current === null ? 0 : Date.now() - sinceRef.current),
      );
    };
    // Primed on the next tick rather than a second later. Someone who joins,
    // reads for two minutes and only then types would otherwise see a full 60s
    // countdown appear and immediately jump — the elapsed time is already
    // banked, it just has not been read yet. A `setTimeout` rather than a call
    // here, because a synchronous set in an effect body is its own lint rule.
    const primer = setTimeout(update, 0);
    const id = setInterval(update, TICK_MS);
    return () => {
      clearTimeout(primer);
      clearInterval(id);
    };
  }, [counting]);

  // ---------------------------------------------------------------------
  // The leaving warning.
  //
  // Registered ONLY while this client is the sole peer, and removed the instant
  // a second one arrives. An always-on `beforeunload` is a prompt on every
  // navigation, which is worse than the problem it solves.
  //
  // Two honest limitations, neither fixable here: browsers ignore custom text
  // and show their own generic prompt (which is why the real sentence lives in
  // the chip's tooltip), and the prompt requires prior interaction with the page
  // (sticky activation), so a tab nobody touched closes silently. It also fires
  // on a *reload*, where the room in fact survives — the reconnect lands inside
  // the 10s grace window. Over-warning there is the accepted trade; the
  // alternative is failing to warn on the case that actually destroys work.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!isLastPeer) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Still set for older browsers, which required a non-empty value.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isLastPeer]);

  const status: PersistenceStatus = !signedIn
    ? "guest"
    : !didEdit
      ? "idle"
      : thresholdMet
        ? "saving"
        : "pending";

  return {
    status,
    remainingMs: Math.max(0, MEMBER_MIN_CONNECTED_MS - elapsedMs),
    isLastPeer,
  };
}
