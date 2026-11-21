import { dayKey } from "@pibot/client-core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import { errorKey } from "../../runtime/errors.ts";
import {
  addEdit,
  emptyEdits,
  emptyTodos,
  type StoredEdits,
  StoredEditsSchema,
  type StoredTodos,
  StoredTodosSchema,
  settleFirst,
  storedRows,
  type TodoEdit,
  type TodoFields,
  type TodoRow,
  todoKeys,
  withAnswer,
  withEdits,
} from "./model.ts";
import { readDoneMonth, readTodos, replayEdit } from "./sync.ts";

// One burst of desktop edits (a Bot adding several to-dos) is read once.
const EVENT_DELAY_MS = 600;

/** Release builds have no remote console: fixed codes only, never a title or date. */
function report(event: string, fields: Record<string, string>) {
  console.info(JSON.stringify({ module: "mobile-todos", event, ...fields }));
}
/** Edits the computer refused, shown once on the tab until dismissed. */
export interface DroppedEdits {
  changed: number;
  failed: number;
}
/**
 * State behind TodosProvider. The tab renders the phone's copy with the waiting edits applied;
 * every edit, online or not, goes through the same queue, which is replayed in order on one lane
 * together with the reads, so an answer and a read never overtake each other.
 */
export function useTodosState() {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const store = runtime.storage.store;
  const computerId = mobile.selectedId;
  const online = mobile.status === "online" && !!mobile.peer;
  const peekCopy = (id: string | undefined) =>
    (id && store.peek(todoKeys.copy(id), StoredTodosSchema)) || emptyTodos;
  const peekEdits = (id: string | undefined) =>
    (id && store.peek(todoKeys.edits(id), StoredEditsSchema)) || emptyEdits;
  const [copy, setCopy] = useState<StoredTodos>(() => peekCopy(computerId));
  const [edits, setEdits] = useState<StoredEdits>(() => peekEdits(computerId));
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<MobileKey>();
  const [dropped, setDropped] = useState<DroppedEdits>({ changed: 0, failed: 0 });
  const copyRef = useRef(copy),
    editsRef = useRef(edits),
    sending = useRef<TodoEdit | undefined>(undefined),
    month = useRef(dayKey(new Date()).slice(0, 7)),
    visible = useRef(false),
    dirty = useRef(false),
    lane = useRef<{ run(work: (signal: AbortSignal) => Promise<void>): void } | undefined>(
      undefined,
    ),
    actions = useRef<{ refresh(): void; drain(): void; month(): void } | undefined>(undefined);
  const scope = useRef(computerId);
  // Edits wait for the stored queue to be read, so a new one never lands before older ones.
  const loaded = useRef<{ done: boolean; wait: Promise<void> }>({
    done: false,
    wait: Promise.resolve(),
  });

  const putCopy = (next: StoredTodos) => {
    copyRef.current = next;
    setCopy(next);
    if (scope.current)
      void store.write(todoKeys.copy(scope.current), next).catch(() => {
        /* The copy is only for the next start or an offline view; the screen is current. */
      });
  };
  // Awaited: an edit counts as made once it survives an app restart.
  const putEdits = (next: StoredEdits) => {
    editsRef.current = next;
    setEdits(next);
    return scope.current ? store.write(todoKeys.edits(scope.current), next) : Promise.resolve();
  };

  // Another computer, or the first read of this one's copy from the phone's database.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected computer owns the copy and queue.
  useEffect(() => {
    scope.current = computerId;
    copyRef.current = peekCopy(computerId);
    editsRef.current = peekEdits(computerId);
    setCopy(copyRef.current);
    setEdits(editsRef.current);
    setReady(false);
    setError(undefined);
    setDropped({ changed: 0, failed: 0 });
    if (!computerId) return;
    let live = true;
    let settle = () => {};
    const gate = { done: false, wait: new Promise<void>((resolve) => (settle = resolve)) };
    loaded.current = gate;
    void Promise.all([
      store.read(todoKeys.copy(computerId), StoredTodosSchema),
      store.read(todoKeys.edits(computerId), StoredEditsSchema),
    ])
      .then(([storedCopy, storedEdits]) => {
        if (!live || scope.current !== computerId) return;
        // A read that already finished is newer than the stored copy.
        if (storedCopy && !copyRef.current.syncedAt) {
          copyRef.current = storedCopy;
          setCopy(storedCopy);
        }
        if (storedEdits) {
          editsRef.current = storedEdits;
          setEdits(storedEdits);
        }
      })
      .catch(() => {
        /* An unreadable copy reads as none; the next online read writes a new one. */
      })
      .finally(() => {
        gate.done = true;
        settle();
        if (live) {
          setReady(true);
          actions.current?.drain();
        }
      });
    return () => {
      live = false;
      settle();
    };
  }, [computerId]);

  // The link: replay what waits, then read; refresh again when the computer says to-dos changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the link (computer, peer, reconnect) owns the lane.
  useEffect(() => {
    if (!online || !computerId) {
      lane.current = undefined;
      actions.current = undefined;
      return;
    }
    const abort = new AbortController();
    const { signal } = abort;
    let tail: Promise<unknown> = Promise.resolve();
    lane.current = {
      run(work) {
        tail = tail
          .then(() => (signal.aborted ? undefined : work(signal)))
          .catch((cause) => {
            if (!signal.aborted) setError(errorKey(cause));
          });
      },
    };
    const run = (work: (signal: AbortSignal) => Promise<void>) => lane.current?.run(work);
    const refresh = () =>
      run(async (s) => {
        setSyncing(true);
        try {
          const next = await readTodos(runtime, copyRef.current, month.current, s);
          s.throwIfAborted();
          putCopy(next);
          setError(undefined);
          dirty.current = false;
        } finally {
          setSyncing(false);
        }
      });
    let draining = false;
    const drain = () => {
      if (draining) return;
      draining = true;
      run(async (s) => {
        try {
          let replayed = false,
            refused = false;
          // The read of the stored queue starts the replay once it is done.
          if (!loaded.current.done) return;
          for (;;) {
            const first = editsRef.current.edits[0];
            if (!first) break;
            sending.current = first;
            const outcome = await replayEdit(runtime, first, s).finally(() => {
              sending.current = undefined;
            });
            s.throwIfAborted();
            replayed = true;
            if (outcome.kind === "dropped") {
              // Latest change wins: the computer's newer version stays, this edit is let go.
              report("edit_dropped", { kind: first.kind, reason: outcome.reason });
              refused = true;
              setDropped((now) =>
                outcome.reason === "changed"
                  ? { ...now, changed: now.changed + 1 }
                  : { ...now, failed: now.failed + 1 },
              );
            } else putCopy(withAnswer(copyRef.current, { id: first.id, ...outcome }));
            await putEdits(
              settleFirst(editsRef.current, outcome.kind === "applied" ? outcome : undefined),
            );
          }
          if (replayed) report("edits_replayed", {});
          // The row went back to the stored version; read the computer's newer one.
          if (refused) refresh();
        } finally {
          draining = false;
        }
      });
    };
    actions.current = {
      refresh,
      drain,
      month: () =>
        run(async (s) => {
          const next = await readDoneMonth(runtime, copyRef.current, month.current, s);
          s.throwIfAborted();
          putCopy(next);
        }),
    };
    drain();
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = mobile.peer?.on("inbox.changed", () => {
      // inbox.changed covers every inbox card; off the tab it only marks the copy for later.
      if (!visible.current) {
        dirty.current = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(refresh, EVENT_DELAY_MS);
    });
    return () => {
      abort.abort();
      clearTimeout(timer);
      off?.();
      lane.current = undefined;
      actions.current = undefined;
    };
  }, [online, computerId, mobile.peer, mobile.refreshVersion, runtime]);

  const shown = useMemo(() => withEdits(storedRows(copy), edits.edits), [copy, edits]);
  const enqueue = async (edit: TodoEdit) => {
    const gate = loaded.current;
    await gate.wait;
    // Another computer was chosen meanwhile; the edit was made on this one's to-dos.
    if (loaded.current !== gate) throw new Error("stale");
    await putEdits(addEdit(editsRef.current, edit, sending.current));
    actions.current?.drain();
  };
  const now = () => new Date().toISOString();
  // The version the edit is made on, in the computer's clock (an overlaid row carries the phone's).
  const known = (id: string) => storedRows(copyRef.current).find((row) => row.id === id)?.updatedAt;
  return {
    ready,
    syncing,
    online,
    error,
    rows: shown.rows,
    /** To-dos with an edit the computer has not taken yet. */
    pending: shown.pending,
    syncedAt: copy.syncedAt,
    openComplete: copy.openComplete,
    undatedCount: copy.undated,
    dropped,
    dismissDropped: () => setDropped({ changed: 0, failed: 0 }),
    /** Pull to refresh: what waits goes first, then the read. */
    refresh: () => {
      actions.current?.drain();
      actions.current?.refresh();
    },
    /** The month on screen: its completed to-dos are read when it is shown. */
    view(next: string) {
      if (month.current === next) return;
      month.current = next;
      actions.current?.month();
    },
    setVisible(next: boolean) {
      visible.current = next;
      if (next && dirty.current) actions.current?.refresh();
    },
    create: (fields: TodoFields) =>
      enqueue({
        kind: "create",
        id: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        at: now(),
        fields,
      }),
    update: (row: TodoRow, fields: TodoFields) =>
      enqueue({ kind: "update", id: row.id, at: now(), base: known(row.id), fields }),
    setStatus: (row: TodoRow, status: TodoRow["status"]) =>
      enqueue({ kind: "status", id: row.id, at: now(), base: known(row.id), status }),
    remove: (row: TodoRow) =>
      enqueue({ kind: "delete", id: row.id, at: now(), base: known(row.id) }),
  };
}
export type TodosState = ReturnType<typeof useTodosState>;
