"use client";

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

// INVARIANT: keep in sync with CLOSE_ROOM_NOT_FOUND in server/src/sync/connection.js.
// Any other close code is an ordinary disconnect and must keep retrying.
const CLOSE_ROOM_NOT_FOUND = 4404;

export type SyncStatus = "connecting" | "connected" | "disconnected";

type MonacoBindingClass = typeof import("y-monaco").MonacoBinding;

// INVARIANT: published through a ref, never state — none of it may drive a render.
type CollabStack = {
  yDoc: Y.Doc;
  awareness: Awareness;
  MonacoBinding: MonacoBindingClass;
};

type UseCollabRoomOptions = {
  roomId: string;
  language: string;
  editor: MonacoEditor | null;
  monaco: MonacoApi | null;
  /** Null until the name prompt is answered; no socket opens before then. */
  user: CollabUser | null;
  onRoomClosed?: () => void;
};

export type CollabRoom = {
  syncStatus: SyncStatus;
  peers: Peer[];
  toasts: ActivityToast[];
  dismissToast: (id: string) => void;
  execState: ExecutionState;
  /** Whether *this* client has edited; half of §10.8's persistence estimate. */
  didEdit: boolean;
  /** INVARIANT: the live doc is a ref, never state — it must drive no render. */
  docRef: React.RefObject<Y.Doc | null>;

  /** In tab order, already sanitized by `readRoomFiles`. */
  files: RoomFile[];
  entryFile: RoomFile | null;
  activeFile: RoomFile | null;
  setActiveFileId: (fileId: string) => void;
  createFile: (name?: string) => void;
  renameFile: (fileId: string, name: string) => void;
  deleteFile: (fileId: string) => void;
  setEntryFileId: (fileId: string) => void;
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

  const [peers, setPeers] = useState<Peer[]>([]);

  const [toasts, setToasts] = useState<ActivityToast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const [execState, setExecState] = useState<ExecutionState>(IDLE_EXECUTION);

  const [didEdit, setDidEdit] = useState(false);

  const [files, setFiles] = useState<RoomFile[]>([]);
  const [entryFileId, setEntryFileIdState] = useState<string | null>(null);

  // A local preference only; the file actually shown is derived below with a
  // fallback, because someone else can delete the file you are reading.
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  const docRef = useRef<Y.Doc | null>(null);

  // `stackEpoch` is what re-runs the binding effect once async setup has landed.
  const stackRef = useRef<CollabStack | null>(null);
  const [stackEpoch, setStackEpoch] = useState(0);

  // INVARIANT: read via a ref so the binding effect never lists it as a
  // dependency — re-running that effect disposes every Monaco model.
  const languageRef = useRef(language);
  useEffect(() => {
    languageRef.current = language;
  });

  // Ref, not a dep: an inline callback would rebuild the Yjs stack every render.
  const onRoomClosedRef = useRef(onRoomClosed);
  useEffect(() => {
    onRoomClosedRef.current = onRoomClosed;
  });

  // Ref, not a dep: the token changes every ~60s, which would rebuild the stack.
  const getToken = useClerkToken();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  });

  // INVARIANT: declared before the master effect — cleanups run in declaration
  // order, so bindings tear down while the `Y.Doc` is still alive.
  // INVARIANT: one long-lived binding per file, never rebuilt on a tab switch —
  // `MonacoBinding.destroy()` leaks its `onDidChangeCursorSelection` listener.
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack || !editor || !monaco) return;
    const { yDoc, awareness, MonacoBinding: Binding } = stack;

    const filesMap = yDoc.getMap<RoomFileMeta>(FILES_MAP_NAME);
    const editors = new Set([editor]);
    const live = new Map<string, { model: MonacoModel; binding: MonacoBinding }>();

    const dispose = (entry: { model: MonacoModel; binding: MonacoBinding }) => {
      // INVARIANT: destroy() before dispose() — it removes the binding's
      // `onWillDispose` hook, so model disposal cannot re-enter destroy().
      entry.binding.destroy();
      entry.model.dispose();
    };

    const sync = () => {
      const current = readRoomFiles(filesMap.entries(), languageRef.current);

      // Create before disposing: the editor must never be left holding a
      // disposed model, which paints an unusable pane.
      for (const file of current) {
        const modelLanguage = monacoLanguageForFile(file.name, languageRef.current);
        const existing = live.get(file.id);
        if (existing) {
          if (existing.model.getLanguageId() !== modelLanguage) {
            monaco.editor.setModelLanguage(existing.model, modelLanguage);
          }
          continue;
        }
        const uri = monaco.Uri.parse(modelPathFor(roomId, file.id));
        // `getModel` first — the `path` prop may already have created this one,
        // and two models on one URI is an error.
        const model =
          monaco.editor.getModel(uri) ?? monaco.editor.createModel("", modelLanguage, uri);
        live.set(file.id, {
          model,
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

  // Owns the whole Yjs lifecycle, so a room switch or StrictMode remount rebuilds
  // it. INVARIANT: `user` is a dep — no socket opens before there is a name.
  useEffect(() => {
    if (!editor || !user) return;

    let cancelled = false;
    const yDoc = new Y.Doc();
    docRef.current = yDoc;
    let provider: WebsocketProvider | null = null;
    let awarenessChangeHandler: (() => void) | null = null;
    let editHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
    // Null until the first snapshot, so peers already here fire no "joined" toast.
    let knownPeers: Map<number, Peer> | null = null;

    const executionMap = yDoc.getMap<ExecutionState>(EXECUTION_MAP_NAME);
    const applyExecutionState = () => {
      setExecState(executionMap.get(EXECUTION_KEY) ?? IDLE_EXECUTION);
    };
    executionMap.observe(applyExecutionState);
    applyExecutionState();

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

    // Any peer may heal a run abandoned by its starter; the other ticks are no-ops.
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
          // Carried through, not dropped: this record replaces the running one whole.
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
      // Both touch browser globals at import time — client-side only.
      const [{ WebsocketProvider }, { MonacoBinding }] = await Promise.all([
        import("y-websocket"),
        import("y-monaco"),
      ]);
      if (cancelled) return;

      // INVARIANT: this verified token is the only channel carrying an account ID
      // to the server — never awareness. It never rejects or hangs, and must not
      // gate the socket, or a deep-linked room becomes unjoinable.
      const token = await getTokenRef.current();
      if (cancelled) return;

      // INVARIANT: `disableBc` stays on — BroadcastChannel resurrects a closed
      // tab in its siblings' awareness, so nobody ever drops out of the user bar.
      provider = new WebsocketProvider(WS_URL, roomId, yDoc, {
        disableBc: true,
        params: token ? { token } : {},
      });

      // y-websocket freezes `params` into `provider.url` once but re-reads that url
      // on every dial, so a ~60s token must be rewritten or reconnects carry a dead
      // one; the base comes from `provider.url`, never rebuilt from WS_URL.
      const baseUrl = provider.url.split("?")[0];
      const tokenProvider = provider;
      provider.on("status", ({ status }: { status: SyncStatus }) => {
        setSyncStatus(status);
        if (status !== "disconnected") return;
        void getTokenRef.current().then((fresh) => {
          if (cancelled) return;
          tokenProvider.url = fresh
            ? `${baseUrl}?token=${encodeURIComponent(fresh)}`
            : baseUrl;
        });
      });

      // Only 4404 is permanent: `disconnect()` stops y-websocket retrying forever,
      // and every other close code must keep retrying.
      const closedProvider = provider;
      closedProvider.on("connection-close", (event: CloseEvent) => {
        if (event?.code !== CLOSE_ROOM_NOT_FOUND) return;
        closedProvider.disconnect();
        if (!cancelled) onRoomClosedRef.current?.();
      });

      // INVARIANT: never `{...user}` — awareness is peer-controlled, so spreading
      // would broadcast `clerkUserId` and let a guest forge one.
      const { awareness } = provider;
      awareness.setLocalStateField("user", {
        name: displayName(user),
        color: user.color,
        firstName: user.firstName,
        lastName: user.lastName,
      });

      awarenessChangeHandler = () => {
        const nextPeers = readPeers(awareness, yDoc.clientID);
        renderAwarenessStyles(nextPeers);
        setPeers(nextPeers);

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

      // INVARIANT: `origin instanceof MonacoBinding` — remote updates and the
      // null-origin seed must not count as this client editing (§10.8).
      editHandler = (_update, origin) => {
        if (origin instanceof MonacoBinding) setDidEdit(true);
      };
      yDoc.on("update", editHandler);

      stackRef.current = { yDoc, awareness, MonacoBinding };
      setStackEpoch((epoch) => epoch + 1);

      // Seed only after `sync`, or the boilerplate merges into everyone's document.
      // The id is the fixed ENTRY_FILE_ID so two simultaneous seeders converge.
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
      // Cleared first so an in-flight run notices the teardown and discards itself.
      docRef.current = null;
      stackRef.current = null;
      clearInterval(staleRunWatchdog);
      executionMap.unobserve(applyExecutionState);
      filesMap.unobserve(applyFiles);
      metaMap.unobserve(applyEntry);
      if (editHandler) yDoc.off("update", editHandler);
      if (provider && awarenessChangeHandler) {
        provider.awareness.off("change", awarenessChangeHandler);
        provider.awareness.setLocalState(null);
      }
      provider?.destroy();
      yDoc.destroy();
      removeAwarenessStyles();
      setPeers([]);
      setToasts([]);
      setExecState(IDLE_EXECUTION);
      setFiles([]);
      setEntryFileIdState(null);
      setDidEdit(false);
    };
  }, [editor, roomId, user]);

  // Derived, not reconciled in an effect: someone else can delete the file you
  // are looking at at any moment.
  const entryFile = useMemo(() => resolveEntryFile(files, entryFileId), [files, entryFileId]);
  const activeFile = useMemo(
    () => files.find((file) => file.id === activeFileId) ?? entryFile,
    [files, activeFileId, entryFile],
  );

  // INVARIANT: every file action latches `didEdit` — they are null-origin
  // transactions the origin filter cannot tell apart from the seed, which must not count.
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
        // Sliced to stay inside `isUsableId`'s printable set: it enters a model URI.
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
        // INVARIANT: whole-record replacement, never a nested mutation.
        filesMap.set(fileId, { ...meta, name: sanitizeFileName(name, languageRef.current) });
      });
    },
    [withDoc],
  );

  const deleteFile = useCallback(
    (fileId: string) => {
      withDoc((yDoc) => {
        const filesMap = yDoc.getMap<RoomFileMeta>(FILES_MAP_NAME);
        // The last file may not be deleted: the seed only runs for a room that
        // has never had one, so there would be no way back.
        if (filesMap.size <= 1 || !filesMap.has(fileId)) return;
        yDoc.transact(() => {
          filesMap.delete(fileId);
          // The Y.Text is deliberately not cleared: a concurrent delete/type pair
          // would otherwise resurrect the entry with its contents wiped.
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

  /** Straight from the doc, so Run reads the entry file and Save reads unopened ones. */
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
