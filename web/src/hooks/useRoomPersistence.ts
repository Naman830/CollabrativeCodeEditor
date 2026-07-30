"use client";

// Nothing here talks to the server: see `lib/data/persistence.ts` for why this can
// only be an estimate, and must promise less than the server guarantees.

import { useEffect, useRef, useState } from "react";
import type { SyncStatus } from "./useCollabRoom";
import type { Peer } from "@/lib/collab/awareness";
import { MEMBER_MIN_CONNECTED_MS, type PersistenceStatus } from "@/lib/data/persistence";
import type { CollabUser } from "@/lib/collab/user";

const TICK_MS = 1_000;

type UseRoomPersistenceOptions = {
  peers: Peer[];
  syncStatus: SyncStatus;
  user: CollabUser | null;
  didEdit: boolean;
};

export type RoomPersistence = {
  status: PersistenceStatus;
  remainingMs: number;
  isLastPeer: boolean;
};

export function useRoomPersistence({
  peers,
  syncStatus,
  user,
  didEdit,
}: UseRoomPersistenceOptions): RoomPersistence {
  const signedIn = Boolean(user?.clerkUserId);

  // INVARIANT: `peers.length === 0` is not "alone" — it is pre-connect/torn-down.
  const isLastPeer =
    syncStatus === "connected" && peers.length === 1 && peers[0].isLocal === true;

  // Time accrues only while the socket is up. INVARIANT: these refs are touched
  // only in effects/timers — never read during render (react-hooks/purity).
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

  // Ticks only while a countdown is on screen, and stops once the threshold is met.
  const counting = signedIn && didEdit && !thresholdMet && syncStatus === "connected";
  useEffect(() => {
    if (!counting) return;
    const update = () => {
      setElapsedMs(
        accumulatedRef.current +
          (sinceRef.current === null ? 0 : Date.now() - sinceRef.current),
      );
    };
    // Primed now so already-banked time shows immediately; a setTimeout because a
    // synchronous set in an effect body is its own lint rule.
    const primer = setTimeout(update, 0);
    const id = setInterval(update, TICK_MS);
    return () => {
      clearTimeout(primer);
      clearInterval(id);
    };
  }, [counting]);

  // INVARIANT: the leaving warning is registered only while this client is the sole
  // peer — an always-on `beforeunload` prompts on every navigation.
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
