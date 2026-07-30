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
import { useClerkToken } from "../lib/clerkIdentity";
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
   * Whether *this* client has made an edit of its own (tasks.md §10.8).
   *
   * Half of the persistence estimate: the server only keeps a snapshot for a
   * signed-in participant who stayed 60s **and** actually edited. It lives here
   * because only this hook can see the doc and the binding.
   */
  didEdit: boolean;
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

  // Latches true on this client's first real edit; see the observer below.
  const [didEdit, setDidEdit] = useState(false);

  // The runner needs the live Y.Doc, but the doc must never live in component
  // state (see the effect below) — a ref triggers no render, so it is safe.
  const docRef = useRef<Y.Doc | null>(null);

  // Read through a ref instead of being an effect dependency: an inline arrow
  // from the caller would otherwise rebuild the whole Yjs stack every render.
  const onRoomClosedRef = useRef(onRoomClosed);
  useEffect(() => {
    onRoomClosedRef.current = onRoomClosed;
  });

  // Also a ref, for a stronger reason than convenience: a Clerk session token
  // lives about 60 seconds, so anything derived from it changes constantly. In
  // the effect's dependency array that would tear down and rebuild the entire
  // Yjs stack — doc, provider, awareness, binding, toasts — every single minute.
  const getToken = useClerkToken();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
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
    let editHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
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
          // Carried through, not dropped: the input is what explains the
          // output, and this record replaces the running one wholesale.
          stdin: current.stdin,
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

      // The sync server records who was in a room from a Clerk token it verifies
      // itself (task 7.3) — never from awareness, which any peer can forge. This
      // is the only channel that carries an account ID to the server.
      //
      // `useClerkToken` never rejects and never hangs: a guest, an unloaded Clerk
      // and a network failure all resolve to null within two seconds. That
      // property is load-bearing, not defensive — holding the socket open on
      // Clerk would repeat the bug documented in `lib/clerkIdentity.ts`, where
      // gating on Clerk left a deep-linked room with no way in at all. A missing
      // token costs a profile entry; a missing socket costs the whole room.
      const token = await getTokenRef.current();
      if (cancelled) return;

      // `disableBc` turns off y-websocket's cross-tab BroadcastChannel. Two tabs
      // are meant to be two collaborators, and BC resurrects a closed tab in its
      // siblings' awareness — the user bar would then never drop anyone.
      provider = new WebsocketProvider(WS_URL, roomId, yDoc, {
        disableBc: true,
        params: token ? { token } : {},
      });

      // y-websocket serialises `params` into `this.url` exactly once, in its
      // constructor — but `setupWS` re-reads `provider.url` on every dial. Since
      // a Clerk token expires in about a minute, every reconnect after the first
      // would otherwise carry a dead token, the server would record nothing, and
      // that user's connected time would silently stop accruing mid-session.
      //
      // Taking the base from `provider.url` rather than rebuilding it from
      // WS_URL guarantees this agrees with y-websocket's own URL construction
      // (trailing-slash stripping included).
      const baseUrl = provider.url.split("?")[0];
      const tokenProvider = provider;
      provider.on("status", ({ status }: { status: SyncStatus }) => {
        setSyncStatus(status);
        if (status !== "disconnected") return;
        // Refresh ahead of the next backoff dial. Failure is fine: the URL just
        // keeps whatever it had, and the socket still reconnects.
        void getTokenRef.current().then((fresh) => {
          if (cancelled) return;
          tokenProvider.url = fresh
            ? `${baseUrl}?token=${encodeURIComponent(fresh)}`
            : baseUrl;
        });
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

      // "Did *I* type anything" — half of the persistence estimate (§10.8).
      //
      // The origin filter is load-bearing, not tidiness. `doc.on("update")`
      // fires for remote updates too, and the `DEFAULT_CODE` seed below is a
      // local transaction as well (with a null origin) — without the filter
      // every joiner would be marked as having edited within milliseconds of
      // arriving, which is precisely the lurker case §6.1's threshold exists to
      // exclude. `MonacoBinding` transacts with itself as the origin, which is
      // the client-side mirror of the server's trick of taking the WebSocket as
      // the transaction origin (see `server/roomState.js`).
      //
      // Note this is *stricter* than the server, which counts any update sent
      // over your socket — the seed included. Erring that way is deliberate:
      // the chip must never claim "saving" earlier than the server would.
      const boundEditor = binding;
      editHandler = (_update, origin) => {
        if (origin === boundEditor) setDidEdit(true);
      };
      yDoc.on("update", editHandler);

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
      if (editHandler) yDoc.off("update", editHandler);
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
      // Belongs to the connection that just died: a new room has to be earned
      // again, and so does a new session in the same one.
      setDidEdit(false);
    };
  }, [editor, roomId, user]);

  return { syncStatus, peers, toasts, dismissToast, execState, didEdit, docRef };
}
