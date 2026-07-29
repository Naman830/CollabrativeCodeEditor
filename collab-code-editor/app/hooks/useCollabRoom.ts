"use client";

// The whole client-side Yjs stack for one room: doc, provider, awareness,
// Monaco binding, the shared execution map, and the presence bookkeeping that
// feeds the user bar and the join/leave toasts.
//
// It is one hook because it is one lifecycle — see the effect's comment below.
// `CodeEditor` renders what this returns and owns nothing of the connection.

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { MonacoBinding } from "y-monaco";
import type { WebsocketProvider } from "y-websocket";
import type { ActivityToast } from "../components/ActivityToasts";
import { readPeers, type Peer } from "../lib/awareness";
import { removeAwarenessStyles, renderAwarenessStyles } from "../lib/cursorStyles";
import {
  EXECUTION_KEY,
  EXECUTION_MAP_NAME,
  IDLE_EXECUTION,
  STALE_RUN_MS,
  type ExecutionState,
} from "../lib/executionState";
import type { MonacoEditor } from "../lib/monacoTypes";
import { WS_URL } from "../lib/rooms";
import { playJoinSound, playLeaveSound } from "../lib/sound";
import { displayName, type CollabUser } from "../lib/user";

const DEFAULT_CODE = `console.log("Hello, world!");\n`;

// The close code the sync server sends for a room that no longer exists
// (`CLOSE_ROOM_NOT_FOUND` in server/yjsConnection.js). Any other close is an
// ordinary disconnect and must keep retrying.
const CLOSE_ROOM_NOT_FOUND = 4404;

export type SyncStatus = "connecting" | "connected" | "disconnected";

type UseCollabRoomOptions = {
  roomId: string;
  /** Null until Monaco has mounted; nothing can bind before then. */
  editor: MonacoEditor | null;
  /** Null until the name prompt is answered; no socket opens before then. */
  user: CollabUser | null;
  /** Fired when the server refuses this room. Only `RoomGate` can act on it. */
  onRoomClosed?: () => void;
};

export type CollabRoom = {
  syncStatus: SyncStatus;
  peers: Peer[];
  toasts: ActivityToast[];
  dismissToast: (id: string) => void;
  execState: ExecutionState;
  /**
   * The live `Y.Doc`, or null while disconnected. A ref, never state: hoisting
   * the doc into state is exactly what the effect below must not do, and a ref
   * drives no render so it carries no such risk.
   */
  docRef: React.RefObject<Y.Doc | null>;
};

export function useCollabRoom({
  roomId,
  editor,
  user,
  onRoomClosed,
}: UseCollabRoomOptions): CollabRoom {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");

  // Awareness is a mutable instance inside the effect below, so React only sees
  // presence changes because they are mirrored into this state.
  const [peers, setPeers] = useState<Peer[]>([]);

  // Join/leave banners, diffed from consecutive peer snapshots below.
  const [toasts, setToasts] = useState<ActivityToast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const [execState, setExecState] = useState<ExecutionState>(IDLE_EXECUTION);

  // The runner needs the live Y.Doc, but the doc must never live in component
  // state (see the effect below) — a ref triggers no render, so it is safe.
  const docRef = useRef<Y.Doc | null>(null);

  // Read through a ref instead of being an effect dependency: an inline arrow
  // from the caller would otherwise rebuild the whole Yjs stack every render.
  const onRoomClosedRef = useRef(onRoomClosed);
  useEffect(() => {
    onRoomClosedRef.current = onRoomClosed;
  });

  // Owns the whole Yjs lifecycle: doc, provider, awareness and binding are all
  // created and torn down here, so switching rooms (or React's StrictMode
  // remount) rebuilds the stack instead of destroying a doc nothing recreates.
  // `user` is a dependency because no socket may open before we know who to
  // announce; it only ever goes null -> set once per mount.
  useEffect(() => {
    if (!editor || !user) return;
    const model = editor.getModel();
    if (!model) return;

    let cancelled = false;
    const yDoc = new Y.Doc();
    docRef.current = yDoc;
    let provider: WebsocketProvider | null = null;
    let binding: MonacoBinding | null = null;
    let awarenessChangeHandler: (() => void) | null = null;
    // Baseline for join/leave detection. Null until the first snapshot, so
    // people already in the room don't each fire a "joined" toast at us.
    let knownPeers: Map<number, Peer> | null = null;

    // Execution state rides on the same Y.Doc as the code, so it syncs to every
    // peer (late joiners included) with no server changes. Registered here
    // rather than in the async block: a Y.Map needs neither socket nor Monaco.
    const executionMap = yDoc.getMap<ExecutionState>(EXECUTION_MAP_NAME);
    const applyExecutionState = () => {
      setExecState(executionMap.get(EXECUTION_KEY) ?? IDLE_EXECUTION);
    };
    executionMap.observe(applyExecutionState);
    applyExecutionState();

    // Any peer can heal a run abandoned by whoever started it — there is no
    // owner once the record is shared, so whichever tick fires first wins and
    // the rest are identical no-ops.
    const staleRunWatchdog = setInterval(() => {
      const current = executionMap.get(EXECUTION_KEY);
      if (
        current?.status === "running" &&
        Date.now() - current.startedAt > STALE_RUN_MS
      ) {
        executionMap.set(EXECUTION_KEY, {
          status: "error",
          runId: current.runId,
          language: current.language,
          startedBy: current.startedBy,
          startedAt: current.startedAt,
          finishedAt: Date.now(),
          error: "Run did not complete (connection to the runner was lost).",
        });
      }
    }, 2000);

    (async () => {
      // Both packages touch browser globals at import time, so they can only be
      // loaded client-side.
      const [{ WebsocketProvider }, { MonacoBinding }] = await Promise.all([
        import("y-websocket"),
        import("y-monaco"),
      ]);
      if (cancelled) return;

      // `disableBc` turns off y-websocket's cross-tab BroadcastChannel. Two tabs
      // are meant to be two collaborators, and BC resurrects a closed tab in its
      // siblings' awareness — the user bar would then never drop anyone.
      provider = new WebsocketProvider(WS_URL, roomId, yDoc, { disableBc: true });
      provider.on("status", ({ status }: { status: SyncStatus }) => {
        setSyncStatus(status);
      });

      // A room can die during a session, and the reconnect is then refused with
      // this code. `disconnect()` is what stops y-websocket retrying forever;
      // every other close code is an ordinary drop that should keep retrying.
      const closedProvider = provider;
      closedProvider.on("connection-close", (event: CloseEvent) => {
        if (event?.code !== CLOSE_ROOM_NOT_FOUND) return;
        closedProvider.disconnect();
        if (!cancelled) onRoomClosedRef.current?.();
      });

      // Publish this user as local presence. `name` is the short caret label;
      // the raw parts ride along for the user bar's initials.
      //
      // Fields are listed one by one and must never become `{...user}`:
      // `CollabUser` now carries `clerkUserId`, and awareness is peer-controlled
      // (see `lib/awareness.ts`), so a broadcast account ID is a claim any
      // client can forge. Task 7.3 keys saved room snapshots on an account —
      // sourcing that from awareness would let a passing guest write a room's
      // code into a stranger's profile. The spread is a one-character change
      // with no visible symptom, which is exactly why this comment is here.
      const { awareness } = provider;
      awareness.setLocalStateField("user", {
        name: displayName(user),
        color: user.color,
        firstName: user.firstName,
        lastName: user.lastName,
      });

      // One handler for both consumers of awareness — the cursor styles and the
      // user bar must never drift apart, or one person looks like two.
      awarenessChangeHandler = () => {
        const nextPeers = readPeers(awareness, yDoc.clientID);
        renderAwarenessStyles(nextPeers);
        setPeers(nextPeers);

        // Diff against the previous snapshot for join/leave. Cursor moves also
        // fire this, but they never add or remove a clientID, so they diff to
        // nothing.
        const nextByClientID = new Map(nextPeers.map((peer) => [peer.clientID, peer]));
        if (knownPeers) {
          const newToasts: ActivityToast[] = [];
          nextByClientID.forEach((peer, clientID) => {
            if (peer.isLocal || knownPeers!.has(clientID)) return;
            newToasts.push({ id: `join-${clientID}-${Date.now()}`, kind: "join", name: peer.name, color: peer.color });
            playJoinSound();
          });
          knownPeers.forEach((peer, clientID) => {
            if (peer.isLocal || nextByClientID.has(clientID)) return;
            newToasts.push({ id: `leave-${clientID}-${Date.now()}`, kind: "leave", name: peer.name, color: peer.color });
            playLeaveSound();
          });
          if (newToasts.length > 0) {
            setToasts((prev) => [...prev, ...newToasts]);
          }
        }
        knownPeers = nextByClientID;
      };
      awareness.on("change", awarenessChangeHandler);
      awarenessChangeHandler();

      const yText = yDoc.getText("monaco");
      binding = new MonacoBinding(yText, model, new Set([editor]), awareness);

      // Seed the starter snippet only once the server has said what the room
      // already contains — seeding earlier would merge the boilerplate into
      // everyone else's document.
      provider.once("sync", (isSynced: boolean) => {
        if (cancelled || !isSynced || yText.length > 0) return;
        yText.insert(0, DEFAULT_CODE);
      });
    })();

    return () => {
      cancelled = true;
      // Cleared first so an in-flight run notices the teardown as early as
      // possible and discards its result.
      docRef.current = null;
      clearInterval(staleRunWatchdog);
      executionMap.unobserve(applyExecutionState);
      if (provider && awarenessChangeHandler) {
        provider.awareness.off("change", awarenessChangeHandler);
        // Clear presence now so peers drop this cursor immediately instead of
        // waiting for the server to notice the socket close.
        provider.awareness.setLocalState(null);
      }
      binding?.destroy();
      provider?.destroy();
      yDoc.destroy();
      removeAwarenessStyles();
      // Peers, toasts and the last result all belong to the connection that
      // just died, not to whatever this reconnects to next.
      setPeers([]);
      setToasts([]);
      setExecState(IDLE_EXECUTION);
    };
  }, [editor, roomId, user]);

  return { syncStatus, peers, toasts, dismissToast, execState, docRef };
}
