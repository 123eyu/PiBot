import { auditResult } from "@pibot/client-core";
import { createTranslator } from "@pibot/i18n";
import type { AuditEntry } from "@pibot/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLanguage, useLinkState, useRuntime } from "../../runtime/context.tsx";
import { useConversations } from "../conversations/conversations-context.tsx";
import { prefetchFailedLogs } from "./log.ts";
import type { RecordRow } from "./model.ts";
import { type RecordWork, readRecords, readSource, syncRecords, writeSource } from "./sync.ts";

type State = { rows: RecordRow[]; truncated: boolean; syncedAt: number; loaded: boolean };
const EMPTY: State = { rows: [], truncated: false, syncedAt: 0, loaded: false };

/**
 * The phone's copy of the computer's run records (cached like
 * conversations): the background sync refreshes it, the 记录 page reads it, and
 * every refresh runs in one queue so two passes never write the same source at once.
 */
function useRecordsState() {
  const runtime = useRuntime(),
    mobile = useLinkState(),
    conversations = useConversations(),
    language = useLanguage();
  const shared = useMemo(() => createTranslator(language), [language]);
  const [state, setState] = useState<State>(EMPTY);
  const computerId = mobile.selectedId;
  const rows = useRef(conversations.rows);
  rows.current = conversations.rows;
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const danger = useCallback(
    (entry: AuditEntry) => auditResult(entry, shared).tone === "danger",
    [shared],
  );
  const reload = useCallback(async () => {
    if (!computerId) return;
    const value = await readRecords(runtime.storage, computerId);
    if (runtime.getSnapshot().selectedId === computerId) setState({ ...value, loaded: true });
  }, [runtime, computerId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the computer owns the copy.
  useEffect(() => {
    setState(EMPTY);
    if (!computerId) return;
    let live = true;
    // Rows that left the window since the last pass are dropped from storage, not only hidden.
    const prune = async () => {
      for (const source of ["audit", "routines", "chats", "commands"] as const) {
        const copy = await readSource(runtime.storage, computerId, source);
        if (copy.syncedAt)
          await writeSource(runtime.storage, computerId, source, copy.rows, copy.truncated);
      }
    };
    void prune()
      .catch(() => undefined) // An unreadable copy is replaced on the next pass.
      .then(() => (live ? reload() : undefined));
    return () => {
      live = false;
    };
  }, [computerId, runtime]);
  const sync = useCallback(
    (work: RecordWork, signal: AbortSignal) => {
      const id = computerId;
      const next = tail.current.then(async () => {
        if (!id || signal.aborted) return;
        try {
          await syncRecords(runtime, runtime.storage, id, rows.current, work, signal);
        } finally {
          if (!signal.aborted) await reload();
        }
        const fresh = await readRecords(runtime.storage, id);
        await prefetchFailedLogs(runtime, runtime.storage.files, id, fresh.rows, danger, signal);
      });
      tail.current = next.catch(() => undefined);
      return next;
    },
    [runtime, computerId, reload, danger],
  );
  return useMemo(() => ({ ...state, sync, reload, danger }), [state, sync, reload, danger]);
}
const Context = createContext<ReturnType<typeof useRecordsState> | null>(null);
export function RecordsProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useRecordsState()}>{children}</Context.Provider>;
}
export function useRecords() {
  const value = useContext(Context);
  if (!value) throw new Error("records_unavailable");
  return value;
}
