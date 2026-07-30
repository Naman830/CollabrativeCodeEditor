"use client";

// The whole client-side Yjs stack for one room: doc, provider, awareness, the
// per-file Monaco bindings, the shared execution map, and the presence
// bookkeeping that feeds the user bar and the join/leave toasts.
//
// It is one hook because it is one lifecycle — see the effects' comments below.
// `CodeEditor` renders what this returns and owns nothing of the connection.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { MonacoBinding } from "y-monaco";
import type { WebsocketProvider } from "y-websocket";
import type { ActivityToast } from "@/components/editor/ActivityToasts";
import { readPeers, type Peer } from "@/lib/collab/awareness";
import { useClerkToken } from "@/lib/collab/clerkIdentity";
import { removeAwarenessStyles, renderAwarenessStyles } from "@/lib/collab/cursorStyles";
import {
  EXECUTION_KEY,
  EXECUTION_MAP_NAME,
  IDLE_EXECUTION,
  STALE_RUN_MS,
  type ExecutionState,
} from "@/lib/sandbox/executionState";
import {
  downloadFileName,
  monacoLanguageForFile,
  newFileName,
  starterCode,
} from "@/lib/editor/languages";
import type { MonacoApi, MonacoEditor, MonacoModel } from "@/lib/editor/monacoTypes";
import {
  ENTRY_FILE_ID,
  ENTRY_KEY,
  FILES_MAP_NAME,
  MAX_FILES,
  ROOM_META_MAP_NAME,
  fileTextName,
  modelPathFor,
  readRoomFiles,
  resolveEntryFile,
  sanitizeFileName,
  type RoomFile,
  type RoomFileMeta,
} from "@/lib/collab/roomFiles";
import { WS_URL } from "@/lib/collab/rooms";
import { playJoinSound, playLeaveSound } from "@/lib/sound";
import { displayName, type CollabUser } from "@/lib/collab/user";

// The close code the sync server sends for a room that no longer exists
// (`CLOSE_ROOM_NOT_FOUND` in server/src/sync/connection.js). Any other close is an
// ordinary disconnect and must keep retrying.
const CLOSE_ROOM_NOT_FOUND = 4404;

export type SyncStatus = "connecting" | "connected" | "disconnected";

/** The `MonacoBinding` class itself, captured from the dynamic import. */
type MonacoBindingClass = typeof import("y-monaco").MonacoBinding;

/**
 * Everything the per-file binding effect needs, published by the master effect
 * once its async setup has finished. A ref rather than state for the same reason
 * `docRef` is: none of it may drive a render.
 */
type CollabStack = {
  yDoc: Y.Doc;
  awareness: Awareness;
  MonacoBinding: MonacoBindingClass;
};

type UseCollabRoomOptions = {
  roomId: string;
  /** The room's language, chosen once at creation (§10.1). Never per-user. */
  language: string;
  /** Null until Monaco has mounted; nothing can bind before then. */
  editor: MonacoEditor | null;
  /** The namespace from `onMount` — needed to create one model per file. */
  monaco: MonacoApi | null;
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
   * because only this hook can see the doc and the bindings.
   */
  didEdit: boolean;
  /**
   * The live `Y.Doc`, or null while disconnected. A ref, never state: hoisting
   * the doc into state is exactly what the effect below must not do, and a ref
   * drives no render so it carries no such risk.
   */
  docRef: React.RefObject<Y.Doc | null>;

  // ── Multi-file (tasks.md §10.1) ──────────────────────────────────────────
  /** Every file in the room, in tab order, already sanitized. */
  files: RoomFile[];
  /** The file Run executes. Null only before the first sync. */
  entryFile: RoomFile | null;
  /** The file the editor is showing. Null only before the first sync. */
  activeFile: RoomFile | null;
  setActiveFileId: (fileId: string) => void;
  createFile: (name?: string) => void;
  renameFile: (fileId: string, name: string) => void;
  deleteFile: (fileId: string) => void;
  setEntryFileId: (fileId: string) => void;
  /** One file's current text, read straight from the doc. "" if it is gone. */
  readFile: (fileId: string) => string;
};

export function useCollabRoom({
  roomId,
  language,
  editor,
  monaco,
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

  // The room's file list and entry pointer, mirrored out of the shared doc.
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [entryFileId, setEntryFileIdState] = useState<string | null>(null);

  // Which tab *this* client is looking at. Purely local: two peers can read
  // different files of the same room, exactly as they could once run different
  // languages before §10.1 moved that to the room.
  //
  // A preference, not the answer — the file actually shown is derived below,
  // with a fallback, because the file you were reading can be deleted by someone
  // else at any moment.
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  // The runner needs the live Y.Doc, but the doc must never live in component
  // state (see the effect below) — a ref triggers no render, so it is safe.
  const docRef = useRef<Y.Doc | null>(null);

  // Published by the master effect for the per-file binding effect. `stackEpoch`
  // is what makes that effect re-run once the async setup has landed.
  const stackRef = useRef<CollabStack | null>(null);
  const [stackEpoch, setStackEpoch] = useState(0);

  // Fixed for the room's life (it comes from the room gate), but read through a
  // ref anyway so the binding effect never lists it as a dependency — that
  // effect owns Monaco models, and re-running it means disposing every one.
  const languageRef = useRef(language);
  useEffect(() => {
    languageRef.current = language;
  });

  // Read through a ref instead of being an effect dependency: an inline arrow
  // from the caller would otherwise rebuild the whole Yjs stack every render.
  const onRoomClosedRef = useRef(onRoomClosed);
  useEffect(() => {
    onRoomClosedRef.current = onRoomClosed;
  });

  // Also a ref, for a stronger reason than convenience: a Clerk session token
  // lives about 60 seconds, so anything derived from it changes constantly. In
  // the effect's dependency array that would tear down and rebuild the entire
  // Yjs stack — doc, provider, awareness, bindings, toasts — every single minute.
  const getToken = useClerkToken();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // One Monaco model and one MonacoBinding per file.
  //
  // DECLARED BEFORE THE MASTER EFFECT ON PURPOSE. React runs effect cleanups in
  // declaration order, so this one tears its bindings down while the `Y.Doc` is
  // still alive, rather than against a doc the master effect has already
  // destroyed.
  //
  // The bindings are **long-lived**: one per file, created when the file appears
  // and destroyed when it goes away — never rebuilt on a tab switch. Two reasons,
  // both verified against y-monaco@0.1.6's source:
  //
  //  - It is unnecessary. `_rerenderDecorations`, `_beforeTransaction` and the
  //    cursor-selection listener all guard on `editor.getModel() === monacoModel`,
  //    and decorations additionally check `anchorAbs.type === ytext`. Every
  //    binding but the visible one is already a no-op.
  //  - It would leak. `MonacoBinding.destroy()` disposes the content and
  //    dispose handlers but **not** the `onDidChangeCursorSelection` listener it
  //    registered on the editor, so churning bindings per switch strands one
  //    listener per switch for the room's life.
  //
  // Reconciliation is driven by the Yjs observer, not by React state, so a file
  // appearing never re-runs this effect (which would dispose every model). The
  // effect's own dependencies are only the things that invalidate *all* of them.
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack || !editor || !monaco) return;
    const { yDoc, awareness, MonacoBinding: Binding } = stack;

    const filesMap = yDoc.getMap<RoomFileMeta>(FILES_MAP_NAME);
    // One Set shared by every binding: `editors` is what a binding checks its
    // model against, and there is exactly one editor for the room's life.
    const editors = new Set([editor]);
    const live = new Map<string, { model: MonacoModel; binding: MonacoBinding }>();

    const dispose = (entry: { model: MonacoModel; binding: MonacoBinding }) => {
      // destroy() first: it disposes the binding's own `onWillDispose` hook, so
      // the model disposal below cannot re-enter destroy().
      entry.binding.destroy();
      entry.model.dispose();
    };

    const sync = () => {
      const current = readRoomFiles(filesMap.entries(), languageRef.current);

      // Create before disposing. If the file being removed is the one in the
      // editor, its replacement has to exist already — leaving the editor
      // holding a disposed model paints an empty, unusable pane until React
      // catches up and swaps `path`.
      for (const file of current) {
        const modelLanguage = monacoLanguageForFile(file.name, languageRef.current);
        const existing = live.get(file.id);
        if (existing) {
          // A rename can change the extension, and therefore the highlighting.
          if (existing.model.getLanguageId() !== modelLanguage) {
            monaco.editor.setModelLanguage(existing.model, modelLanguage);
          }
          continue;
        }
        const uri = monaco.Uri.parse(modelPathFor(roomId, file.id));
        // `getModel` first: `@monaco-editor/react` may already have created this
        // one from the `path` prop, and two models on one URI is an error.
        const model =
          monaco.editor.getModel(uri) ?? monaco.editor.createModel("", modelLanguage, uri);
        live.set(file.id, {
          model,
          // Fills the model from the Y.Text on construction, so a tab opened for
          // the first time shows the room's real contents immediately.
          binding: new Binding(yDoc.getText(fileTextName(file.id)), model, editors, awareness),
        });
      }

      const wanted = new Set(current.map((file) => file.id));
      for (const [id, entry] of live) {
        if (wanted.has(id)) continue;
        live.delete(id);
        if (editor.getModel() === entry.model) {
          const survivor = live.values().next().value;
          if (survivor) editor.setModel(survivor.model);
        }
        dispose(entry);
      }
    };

    filesMap.observe(sync);
    sync();

    return () => {
      filesMap.unobserve(sync);
      for (const entry of live.values()) dispose(entry);
      live.clear();
    };
  }, [stackEpoch, editor, monaco, roomId]);

  // ─────────────────────────────────────────────────────────────────────────
  // Owns the whole Yjs lifecycle: doc, provider, awareness and the shared maps
  // are all created and torn down here, so switching rooms (or React's
  // StrictMode remount) rebuilds the stack instead of destroying a doc nothing
  // recreates. `user` is a dependency because no socket may open before we know
  // who to announce; it only ever goes null -> set once per mount.
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!editor || !user) return;

    let cancelled = false;
    const yDoc = new Y.Doc();
    docRef.current = yDoc;
    let provider: WebsocketProvider | null = null;
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

    // The file list and the entry pointer, on the same doc for the same reason
    // (§10.1). Two maps rather than one: the entry pointer is replaced whole
    // under a single key, exactly as the execution record is, while the file
    // map is keyed per file so two peers adding two files never contend.
    const filesMap = yDoc.getMap<RoomFileMeta>(FILES_MAP_NAME);
    const metaMap = yDoc.getMap<string>(ROOM_META_MAP_NAME);
    const applyFiles = () => {
      setFiles(readRoomFiles(filesMap.entries(), languageRef.current));
    };
    const applyEntry = () => {
      setEntryFileIdState(metaMap.get(ENTRY_KEY) ?? null);
    };
    filesMap.observe(applyFiles);
    metaMap.observe(applyEntry);
    applyFiles();
    applyEntry();

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
          // Carried through, not dropped: the input and the file are what
          // explain the output, and this record replaces the running one
          // wholesale.
          filename: current.filename,
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
      // Clerk would repeat the bug documented in `lib/collab/clerkIdentity.ts`, where
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
      // (see `lib/collab/awareness.ts`), so a broadcast account ID is a claim any
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

      // "Did *I* type anything" — half of the persistence estimate (§10.8).
      //
      // The origin filter is load-bearing, not tidiness. `doc.on("update")`
      // fires for remote updates too, and the seed below is a local transaction
      // as well (with a null origin) — without the filter every joiner would be
      // marked as having edited within milliseconds of arriving, which is
      // precisely the lurker case §6.1's threshold exists to exclude.
      // `MonacoBinding` transacts with itself as the origin, which is the
      // client-side mirror of the server's trick of taking the WebSocket as the
      // transaction origin (see `server/src/rooms/state.js`).
      //
      // `instanceof`, not identity against one binding: since §10.1 there is one
      // binding per file, and typing in any of them is typing.
      //
      // Note this is *stricter* than the server, which counts any update sent
      // over your socket — the seed included. Erring that way is deliberate:
      // the chip must never claim "saving" earlier than the server would.
      editHandler = (_update, origin) => {
        if (origin instanceof MonacoBinding) setDidEdit(true);
      };
      yDoc.on("update", editHandler);

      // Hand the binding effect above everything it needs, and wake it up.
      stackRef.current = { yDoc, awareness, MonacoBinding };
      setStackEpoch((epoch) => epoch + 1);

      // Seed the starter file only once the server has said what the room
      // already contains — seeding earlier would merge the boilerplate into
      // everyone else's document.
      //
      // The id is the fixed `ENTRY_FILE_ID`, never a random one: two peers can
      // sync into an empty room at the same moment and both run this, and a
      // fixed key means they converge on one file rather than CRDT-merging into
      // two identical tabs. See `lib/collab/roomFiles.ts`, rule 1.
      provider.once("sync", (isSynced: boolean) => {
        if (cancelled || !isSynced || filesMap.size > 0) return;
        const seedLanguage = languageRef.current;
        yDoc.transact(() => {
          filesMap.set(ENTRY_FILE_ID, {
            name: downloadFileName(seedLanguage),
            createdAt: Date.now(),
          });
          metaMap.set(ENTRY_KEY, ENTRY_FILE_ID);
          const text = yDoc.getText(fileTextName(ENTRY_FILE_ID));
          if (text.length === 0) text.insert(0, starterCode(seedLanguage));
        });
      });
    })();

    return () => {
      cancelled = true;
      // Cleared first so an in-flight run notices the teardown as early as
      // possible and discards its result.
      docRef.current = null;
      stackRef.current = null;
      clearInterval(staleRunWatchdog);
      executionMap.unobserve(applyExecutionState);
      filesMap.unobserve(applyFiles);
      metaMap.unobserve(applyEntry);
      if (editHandler) yDoc.off("update", editHandler);
      if (provider && awarenessChangeHandler) {
        provider.awareness.off("change", awarenessChangeHandler);
        // Clear presence now so peers drop this cursor immediately instead of
        // waiting for the server to notice the socket close.
        provider.awareness.setLocalState(null);
      }
      provider?.destroy();
      yDoc.destroy();
      removeAwarenessStyles();
      // Peers, toasts, files and the last result all belong to the connection
      // that just died, not to whatever this reconnects to next.
      setPeers([]);
      setToasts([]);
      setExecState(IDLE_EXECUTION);
      setFiles([]);
      setEntryFileIdState(null);
      // Belongs to the connection that just died: a new room has to be earned
      // again, and so does a new session in the same one.
      setDidEdit(false);
    };
  }, [editor, roomId, user]);

  // ── Derived selection ────────────────────────────────────────────────────
  // Both are derived rather than reconciled in an effect, because both can be
  // invalidated by *someone else* deleting a file at any moment. An effect that
  // corrected the state afterwards would render one frame pointing at a file
  // that is gone — and React 19's `set-state-in-effect` rule rejects it anyway.
  const entryFile = useMemo(() => resolveEntryFile(files, entryFileId), [files, entryFileId]);
  const activeFile = useMemo(
    () => files.find((file) => file.id === activeFileId) ?? entryFile,
    [files, activeFileId, entryFile],
  );

  // ── File actions ─────────────────────────────────────────────────────────
  // Every one of these is a deliberate user action, so each latches `didEdit`.
  // The `origin` filter above cannot see them: they are local transactions with
  // a null origin, exactly like the seed — which must *not* count. The
  // difference is intent, and only the call site knows it.
  const withDoc = useCallback((fn: (yDoc: Y.Doc) => void) => {
    const yDoc = docRef.current;
    if (!yDoc) return;
    fn(yDoc);
    setDidEdit(true);
  }, []);

  const createFile = useCallback(
    (name?: string) => {
      withDoc((yDoc) => {
        const filesMap = yDoc.getMap<RoomFileMeta>(FILES_MAP_NAME);
        if (filesMap.size >= MAX_FILES) return;
        const existing = readRoomFiles(filesMap.entries(), languageRef.current);
        const chosen = name?.trim()
          ? sanitizeFileName(name, languageRef.current)
          : newFileName(languageRef.current, existing.map((file) => file.name));
        // `crypto.randomUUID` is available in every browser this app supports and
        // the slice keeps the id inside `isUsableId`'s printable set, since it
        // becomes part of a Monaco model URI.
        const id = crypto.randomUUID().slice(0, 8);
        filesMap.set(id, { name: chosen, createdAt: Date.now() });
        setActiveFileId(id);
      });
    },
    [withDoc],
  );

  const renameFile = useCallback(
    (fileId: string, name: string) => {
      withDoc((yDoc) => {
        const filesMap = yDoc.getMap<RoomFileMeta>(FILES_MAP_NAME);
        const meta = filesMap.get(fileId);
        if (!meta) return;
        // Whole-record replacement, never a nested mutation — rule 3.
        filesMap.set(fileId, { ...meta, name: sanitizeFileName(name, languageRef.current) });
      });
    },
    [withDoc],
  );

  const deleteFile = useCallback(
    (fileId: string) => {
      withDoc((yDoc) => {
        const filesMap = yDoc.getMap<RoomFileMeta>(FILES_MAP_NAME);
        // The last file may not be deleted: an editor with no model is a blank
        // pane with no way back, and the seed only runs for a room that has
        // never had one.
        if (filesMap.size <= 1 || !filesMap.has(fileId)) return;
        yDoc.transact(() => {
          filesMap.delete(fileId);
          // The Y.Text is deliberately *not* cleared. Yjs keeps a tombstone for
          // deleted content either way, so clearing it saves nothing, and a
          // concurrent "delete the file" / "type in the file" pair would
          // otherwise resurrect an entry with its contents wiped.
          const metaMap = yDoc.getMap<string>(ROOM_META_MAP_NAME);
          if (metaMap.get(ENTRY_KEY) === fileId) {
            const next = readRoomFiles(filesMap.entries(), languageRef.current)[0];
            if (next) metaMap.set(ENTRY_KEY, next.id);
          }
        });
      });
    },
    [withDoc],
  );

  const setEntryFileId = useCallback(
    (fileId: string) => {
      withDoc((yDoc) => {
        if (!yDoc.getMap<RoomFileMeta>(FILES_MAP_NAME).has(fileId)) return;
        yDoc.getMap<string>(ROOM_META_MAP_NAME).set(ENTRY_KEY, fileId);
      });
    },
    [withDoc],
  );

  /**
   * One file's text, straight from the doc rather than from Monaco.
   *
   * This is what makes Run execute the *entry* file while you are looking at
   * another one, and what lets Save zip files that have no model yet.
   */
  const readFile = useCallback((fileId: string) => {
    const yDoc = docRef.current;
    if (!yDoc) return "";
    return yDoc.getText(fileTextName(fileId)).toString();
  }, []);

  return {
    syncStatus,
    peers,
    toasts,
    dismissToast,
    execState,
    didEdit,
    docRef,
    files,
    entryFile,
    activeFile,
    setActiveFileId,
    createFile,
    renameFile,
    deleteFile,
    setEntryFileId,
    readFile,
  };
}
