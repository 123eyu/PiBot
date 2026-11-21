import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import { useConversations } from "../conversations/conversations-context.tsx";
import type { Conversation } from "../conversations/model.ts";
import { useRecords } from "../records/records-context.tsx";
import { FULL_SYNC, mergeWork, type RecordWork } from "../records/sync.ts";
import {
  CATALOG_REFRESH_MS,
  type CatalogWork,
  mergeCatalogWork,
  syncCatalog,
} from "./catalog-sync.ts";
import {
  type PrefetchItem,
  prefetchCandidates,
  prefetchFiles,
  SYNC_LIMITS,
  syncConversation,
} from "./conversation-sync.ts";

// Let the visible screens take the first requests after a (re)connect.
const START_DELAY_MS = 2_000;
const EVENT_DELAY_MS = 1_500;
// Settings edits come in bursts (a desktop panel saves field by field).
const CATALOG_EVENT_DELAY_MS = 5_000;

function useForeground() {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  return active;
}
/**
 * Keeps the most recent conversations readable offline: on each connect,
 * and when a reply finishes or a message arrives, it refreshes their cached history and then
 * prefetches their images and small files. The run records of the last 3 days ride
 * the same lane: a full pass on connect, then the sources an event touched. What changes rarely
 * (Bot and group settings, skills, connections, the device list; catalog-sync.ts) comes last on
 * connect, then every 15 minutes and when a change event names it. Foreground and online only; one request at a time; everything stops on disconnect or background. Renders
 * nothing.
 */
export function BackgroundSync() {
  const runtime = useRuntime(),
    mobile = useLinkState(),
    conversations = useConversations(),
    foreground = useForeground(),
    records = useRecords();
  const recordSync = useRef(records.sync);
  recordSync.current = records.sync;
  const rows = useRef<Conversation[]>(conversations.rows);
  rows.current = conversations.rows;
  const hasRows = conversations.rows.length > 0;
  const computerId = mobile.selectedId;
  const peer = mobile.peer;
  const online = mobile.status === "online";
  useEffect(() => {
    if (!online || !foreground || !peer || !computerId || !hasRows) return;
    const abort = new AbortController();
    const { signal } = abort;
    let tail: Promise<unknown> = Promise.resolve();
    // One lane: history refreshes and downloads never run in parallel.
    const enqueue = (work: () => Promise<unknown>) => {
      tail = tail.then(() => (signal.aborted ? undefined : work())).catch(() => undefined);
    };
    const refresh = async (targets: Conversation[]) => {
      const files: PrefetchItem[] = [];
      for (const row of targets) {
        signal.throwIfAborted();
        try {
          const messages = await syncConversation(
            runtime,
            runtime.storage,
            computerId,
            row,
            signal,
          );
          files.push(...prefetchCandidates(messages));
        } catch (error) {
          if (signal.aborted) throw error;
          // One conversation too large or gone must not stop the others.
        }
      }
      await prefetchFiles(runtime, runtime.storage.files, computerId, files, signal);
    };
    const catalog = (work: CatalogWork) =>
      enqueue(() => syncCatalog(runtime, runtime.storage, computerId, rows.current, work, signal));
    const start = setTimeout(() => {
      enqueue(() => refresh(rows.current.slice(0, SYNC_LIMITS.conversations)));
      enqueue(() => recordSync.current(FULL_SYNC, signal));
      // Last on the lane: what is current (chats, records) comes before what is kept ahead.
      catalog({ all: true });
    }, START_DELAY_MS);
    const periodic = setInterval(() => catalog({ all: true }), CATALOG_REFRESH_MS);
    // A change on the computer refreshes the stored copy it touched, not only on the timer.
    let catalogDirty: CatalogWork = {};
    let catalogTimer: ReturnType<typeof setTimeout> | undefined;
    const catalogTouched = (work: CatalogWork) => {
      catalogDirty = mergeCatalogWork(catalogDirty, work);
      clearTimeout(catalogTimer);
      catalogTimer = setTimeout(() => {
        const next = catalogDirty;
        catalogDirty = {};
        catalog(next);
      }, CATALOG_EVENT_DELAY_MS);
    };
    let dirty: RecordWork = {};
    let recordTimer: ReturnType<typeof setTimeout> | undefined;
    const recordsTouched = (work: RecordWork) => {
      dirty = mergeWork(dirty, work);
      clearTimeout(recordTimer);
      recordTimer = setTimeout(() => {
        const next = dirty;
        dirty = {};
        enqueue(() => recordSync.current(next, signal));
      }, EVENT_DELAY_MS);
    };
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const touched = (event: { botId?: string; groupId?: string }) => {
      const recent = rows.current.slice(0, SYNC_LIMITS.conversations);
      const row = event.groupId
        ? recent.find((item) => item.kind === "group" && item.id === event.groupId)
        : recent.find((item) => item.kind === "bot" && item.id === event.botId);
      if (!row) return;
      clearTimeout(timers.get(row.key));
      timers.set(
        row.key,
        setTimeout(() => {
          timers.delete(row.key);
          enqueue(() => refresh([row]));
        }, EVENT_DELAY_MS),
      );
    };
    const replyDone = (event: { botId?: string; groupId?: string }) => {
      touched(event);
      const row = event.groupId
        ? rows.current.find((item) => item.kind === "group" && item.id === event.groupId)
        : rows.current.find((item) => item.kind === "bot" && item.id === event.botId);
      recordsTouched({ audit: true, ...(row ? { chats: [row] } : {}) });
    };
    const off = [
      peer.on("chat.done", replyDone),
      peer.on("chat.message", touched),
      peer.on("routine.run", () => recordsTouched({ routines: true, audit: true })),
      peer.on("routines.changed", () => recordsTouched({ audit: true })),
      peer.on("approval.resolved", () => recordsTouched({ audit: true })),
      peer.on("backgroundCommands.changed", () => recordsTouched({ commands: true, audit: true })),
      peer.on("bots.changed", (event) => catalogTouched({ bots: [event.botId] })),
      peer.on("groups.changed", (event) => catalogTouched({ groups: [event.groupId] })),
      // Skills and connections can change for many Bots at once; the next pass covers them all.
      peer.on("skills.changed", () => catalogTouched({ all: true })),
      peer.on("connectors.changed", () => catalogTouched({ all: true })),
      peer.on("devices.changed", () => catalogTouched({ devices: true })),
    ];
    return () => {
      abort.abort();
      clearTimeout(start);
      clearInterval(periodic);
      clearTimeout(catalogTimer);
      clearTimeout(recordTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      for (const fn of off) fn();
    };
  }, [online, foreground, peer, computerId, hasRows, runtime]);
  return null;
}
