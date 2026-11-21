import { GroupSessionCache } from "@pibot/client-core";
import {
  emptyWorkspace,
  useRpc,
  WorkspaceContext,
  type WorkspaceData,
  waitRpc,
} from "@pibot/renderer-kit";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { applyStatus } from "./group-status.ts";
import { hydrateEntries, summaries } from "./reads.ts";
import { readWorkspaceDetails, readWorkspaceHeader, type WorkspaceHeader } from "./refresh.ts";

const GroupCacheContext = createContext<GroupSessionCache | undefined>(undefined);

/** Sidebar rows whose preview or run state may have changed; "all" when nothing narrower is known. */
type Scope = ReadonlySet<string> | "all";
const none: Scope = new Set<string>();
function merge(a: Scope, b: Scope): Scope {
  if (a === "all" || b === "all") return "all";
  if (!b.size) return a;
  if (!a.size) return b;
  return new Set([...a, ...b]);
}
const routeScope = (route: { botId?: string; groupId?: string }): Scope =>
  route.groupId
    ? new Set([`group:${route.groupId}`])
    : route.botId
      ? new Set([`dm:${route.botId}`])
      : "all";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { peer } = useRpc();
  const [groupCache] = useState(() => new GroupSessionCache());
  useEffect(() => {
    groupCache.bindPeer(peer ?? undefined);
    const off = peer
      ? [
          peer.on("groups.changed", (event) => groupCache.invalidateGroup(event.groupId)),
          peer.on("bots.changed", () => groupCache.clear()),
          peer.on("permissions.changed", () => groupCache.clear()),
          ...(["chat.done", "chat.error", "chat.attachments", "chat.status"] as const).map(
            (event) =>
              peer.on(event, (payload) => {
                if (payload.groupId)
                  groupCache.invalidateConversation(
                    payload.groupId,
                    payload.conversationId,
                    payload.threadId,
                  );
              }),
          ),
        ]
      : [];
    return () => {
      for (const unsubscribe of off) unsubscribe();
      groupCache.clear();
    };
  }, [peer, groupCache]);
  const [data, setData] = useState<WorkspaceData>(emptyWorkspace);
  const current = useRef(data);
  current.current = data;
  const version = useRef(0);
  const statusRevision = useRef(0);
  const paging = useRef(false);
  const catalogPaging = useRef(false);
  const sectionPaging = useRef(false);
  const botCursor = useRef<string | undefined>(undefined);
  const lifetime = useRef(new AbortController());
  const pageLifetime = useRef(new AbortController());
  const scope = useRef({ peer, active: false });
  const refreshJob = useRef<Promise<void> | undefined>(undefined);
  const detailsJob = useRef<Promise<void> | undefined>(undefined);
  const refreshAgain = useRef(false);
  const pendingDetails = useRef<
    { header: WorkspaceHeader; token: number; include: ReadonlySet<string> } | undefined
  >(undefined);
  // Rows named by events since the last completed details read. A read that is superseded or
  // fails hands its rows back, so a later refresh still covers them.
  const unsettled = useRef<Scope>("all");
  const recoverDetails = useCallback(() => {
    if (!peer || detailsJob.current) return;
    const owner = scope.current;
    const job = (async () => {
      while (pendingDetails.current && owner.active && scope.current === owner) {
        const { header, token, include } = pendingDetails.current;
        pendingDetails.current = undefined;
        const signal = lifetime.current.signal;
        const valid = () =>
          owner.active && scope.current === owner && token === version.current && !signal.aborted;
        if (!valid()) continue;
        const taken = unsettled.current;
        unsettled.current = none;
        const listed = new Set(header.entries.map((entry) => entry.conversationKey));
        let settled = false;
        try {
          await readWorkspaceDetails(
            peer,
            header,
            signal,
            {
              current: valid,
              publish: (patch) => {
                if (!valid()) return;
                setData((previous) => {
                  if (!valid()) return previous;
                  const next = { ...previous, ...patch };
                  // Supplementary reads began with the first page; keep pages loaded meanwhile.
                  if (patch.bots) {
                    const bots = new Map(previous.bots.map((bot) => [bot.id, bot]));
                    for (const bot of patch.bots) bots.set(bot.id, bot);
                    next.bots = [...bots.values()];
                  }
                  if (patch.groups) {
                    const groups = new Map(previous.groups.map((group) => [group.id, group]));
                    for (const group of patch.groups) groups.set(group.id, group);
                    next.groups = [...groups.values()];
                  }
                  if (patch.summaries)
                    next.summaries = { ...previous.summaries, ...patch.summaries };
                  return next;
                });
              },
              statusRevision: () => statusRevision.current,
              statuses: (recovered, revision, ids) => {
                if (!valid()) return;
                // Rows outside this read keep their state; with every row read this is a replace.
                const kept = (key: string) => listed.has(key) && !ids.has(key);
                setData((previous) => {
                  if (!valid() || revision !== statusRevision.current) return previous;
                  const statuses = Object.fromEntries(
                    Object.entries(previous.statuses).filter(([, status]) =>
                      status.groupId
                        ? !ids.has(`group:${status.groupId}`) ||
                          recovered.uncertain.includes(status.groupId)
                        : !ids.has(`dm:${status.botId}`) ||
                          recovered.uncertainBots.includes(status.botId as string),
                    ),
                  );
                  return {
                    ...previous,
                    statuses: { ...statuses, ...recovered.statuses },
                    uncertainGroups: [
                      ...previous.uncertainGroups.filter((id) => kept(`group:${id}`)),
                      ...recovered.uncertain,
                    ],
                    uncertainBots: [
                      ...(previous.uncertainBots ?? []).filter((id) => kept(`dm:${id}`)),
                      ...recovered.uncertainBots,
                    ],
                  };
                });
              },
            },
            taken === "all" ? undefined : new Set([...taken, ...include]),
          );
          settled = valid();
        } catch {
          if (valid()) setData((previous) => ({ ...previous, detailsError: true }));
        } finally {
          if (!settled) unsettled.current = merge(unsettled.current, taken);
        }
      }
    })().finally(() => {
      if (scope.current !== owner || !owner.active) return;
      detailsJob.current = undefined;
      // A header can arrive after the loop exits but before this promise reaction.
      if (pendingDetails.current) {
        recoverDetails();
        return;
      }
      setData((previous) => ({ ...previous, detailsLoading: false }));
    });
    detailsJob.current = job;
  }, [peer]);
  const reread = useCallback((): Promise<void> => {
    if (!peer || !scope.current.active || scope.current.peer !== peer) return Promise.resolve();
    if (refreshJob.current) {
      refreshAgain.current = true;
      return refreshJob.current;
    }
    const owner = scope.current;
    const job = (async () => {
      do {
        refreshAgain.current = false;
        pageLifetime.current.abort();
        pageLifetime.current = new AbortController();
        const signal = lifetime.current.signal;
        const token = ++version.current;
        const valid = () =>
          owner.active && scope.current === owner && !signal.aborted && token === version.current;
        paging.current = catalogPaging.current = sectionPaging.current = true;
        setData((previous) => ({ ...previous, refreshing: true }));
        try {
          const header = await readWorkspaceHeader(peer, signal);
          if (!valid()) return;
          botCursor.current = header.botCursor;
          // Rows without a confirmed preview are read whatever the event named.
          const shown = current.current;
          const unconfirmed = new Set([
            ...shown.uncertainGroups.map((id) => `group:${id}`),
            ...(shown.uncertainBots ?? []).map((id) => `dm:${id}`),
          ]);
          const include = new Set(
            header.entries
              .map((entry) => entry.conversationKey)
              .filter((key) => !shown.summaries[key] || unconfirmed.has(key)),
          );
          setData((previous) => {
            const known = new Set(previous.entries.map((entry) => entry.conversationKey));
            const uncertain = new Set([
              ...previous.uncertainGroups.map((id) => `group:${id}`),
              ...(previous.uncertainBots ?? []).map((id) => `dm:${id}`),
            ]);
            // A background recheck must not blank every already-confirmed row's preview.
            const waiting = header.entries.filter(
              (entry) => !known.has(entry.conversationKey) || uncertain.has(entry.conversationKey),
            );
            return {
              ...previous,
              ...header,
              loading: false,
              error: false,
              detailsLoading: true,
              uncertainGroups: waiting
                .filter((entry) => entry.conversationKey.startsWith("group:"))
                .map((entry) => entry.conversationKey.slice(6)),
              uncertainBots: waiting
                .filter((entry) => entry.conversationKey.startsWith("dm:"))
                .map((entry) => entry.conversationKey.slice(3)),
            };
          });
          pendingDetails.current = { header, token, include };
          recoverDetails();
        } catch {
          if (valid()) setData((previous) => ({ ...previous, loading: false, error: true }));
        } finally {
          if (valid()) paging.current = catalogPaging.current = sectionPaging.current = false;
        }
      } while (owner.active && scope.current === owner && refreshAgain.current);
    })().finally(() => {
      if (scope.current !== owner || !owner.active) return;
      refreshJob.current = undefined;
      // Keep callers waiting for a request queued between loop exit and cleanup.
      if (refreshAgain.current) return reread();
      setData((previous) => ({ ...previous, refreshing: false }));
    });
    refreshJob.current = job;
    return job;
  }, [peer, recoverDetails]);
  // Callers outside this provider cannot say what changed, so their refresh re-reads every row.
  const refresh = useCallback((): Promise<void> => {
    unsettled.current = "all";
    return reread();
  }, [reread]);
  const more = useCallback(async () => {
    if (
      !peer ||
      !scope.current.active ||
      scope.current.peer !== peer ||
      paging.current ||
      !current.current.hasMore
    )
      return;
    paging.current = true;
    const token = version.current;
    const signal = AbortSignal.any([
      lifetime.current.signal,
      pageLifetime.current.signal,
      AbortSignal.timeout(30_000),
    ]);
    const before = current.current.entries.at(-1)?.conversationKey.split(":")[1];
    try {
      signal.throwIfAborted();
      const next = await waitRpc(() => peer.call("sidebar.list", { before, limit: 50 }), signal);
      signal.throwIfAborted();
      if (token !== version.current) return;
      const metadata = await hydrateEntries(
        peer,
        next.entries,
        current.current.bots,
        current.current.groups,
        signal,
      );
      const preview = await summaries(peer, next.entries, metadata.bots, metadata.groups, signal);
      if (token !== version.current) return;
      setData((previous) => {
        const ids = new Set(previous.entries.map((e) => e.conversationKey));
        // metadata started from the bots/groups present before the awaits; moreBots() or the
        // details read may have published newer pages since. Only add identities still missing.
        const bots = new Map(previous.bots.map((bot) => [bot.id, bot]));
        for (const bot of metadata.bots) if (!bots.has(bot.id)) bots.set(bot.id, bot);
        const groups = new Map(previous.groups.map((group) => [group.id, group]));
        for (const group of metadata.groups) if (!groups.has(group.id)) groups.set(group.id, group);
        return {
          ...previous,
          bots: [...bots.values()],
          groups: [...groups.values()],
          entries: [
            ...previous.entries,
            ...next.entries.filter((e) => !ids.has(e.conversationKey)),
          ],
          summaries: { ...previous.summaries, ...preview },
          hasMore: next.entries.length === 50,
          error: false,
        };
      });
    } catch {
      if (!signal.aborted && token === version.current)
        setData((previous) => ({ ...previous, error: true }));
    } finally {
      if (token === version.current) paging.current = false;
    }
  }, [peer]);
  const moreBots = useCallback(async () => {
    if (
      !peer ||
      !scope.current.active ||
      scope.current.peer !== peer ||
      catalogPaging.current ||
      !current.current.hasMoreBots
    )
      return;
    catalogPaging.current = true;
    const token = version.current;
    const signal = AbortSignal.any([
      lifetime.current.signal,
      pageLifetime.current.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      signal.throwIfAborted();
      const next = await waitRpc(
        () => peer.call("bots.list", { before: botCursor.current, limit: 200 }),
        signal,
      );
      signal.throwIfAborted();
      if (token !== version.current) return;
      botCursor.current = next.at(-1)?.id;
      setData((previous) => {
        const byId = new Map(previous.bots.map((b) => [b.id, b]));
        for (const bot of next) if (!bot.archivedAt) byId.set(bot.id, bot);
        return { ...previous, bots: [...byId.values()], hasMoreBots: next.length === 200 };
      });
    } catch {
      if (!signal.aborted && token === version.current)
        setData((previous) => ({ ...previous, error: true }));
    } finally {
      if (token === version.current) catalogPaging.current = false;
    }
  }, [peer]);
  const moreSections = useCallback(async () => {
    if (
      !peer ||
      !scope.current.active ||
      scope.current.peer !== peer ||
      sectionPaging.current ||
      !current.current.hasMoreSections
    )
      return;
    sectionPaging.current = true;
    const token = version.current;
    const signal = AbortSignal.any([
      lifetime.current.signal,
      pageLifetime.current.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      signal.throwIfAborted();
      const next = await waitRpc(
        () =>
          peer.call("sidebar.groups.list", {
            before: current.current.sections.at(-1)?.id,
            limit: 200,
          }),
        signal,
      );
      signal.throwIfAborted();
      if (token !== version.current) return;
      setData((previous) => {
        const ids = new Set(previous.sections.map((s) => s.id));
        return {
          ...previous,
          sections: [...previous.sections, ...next.filter((s) => !ids.has(s.id))],
          hasMoreSections: next.length === 200,
        };
      });
    } catch {
      if (!signal.aborted && token === version.current)
        setData((previous) => ({ ...previous, error: true }));
    } finally {
      if (token === version.current) sectionPaging.current = false;
    }
  }, [peer]);
  useEffect(() => {
    scope.current = { peer, active: true };
    lifetime.current = new AbortController();
    pageLifetime.current = new AbortController();
    refreshJob.current = detailsJob.current = undefined;
    refreshAgain.current = false;
    pendingDetails.current = undefined;
    unsettled.current = "all";
    paging.current = false;
    catalogPaging.current = false;
    sectionPaging.current = false;
    setData(emptyWorkspace);
    void reread();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Every event re-reads the list, catalog and inbox (one call each); only the rows it names
    // re-read their preview and runs. A burst inside the window is coalesced into one refresh.
    const schedule = (rows: Scope) => {
      unsettled.current = merge(unsettled.current, rows);
      timer ??= setTimeout(() => {
        timer = undefined;
        void reread();
      }, 250);
    };
    // Inbox badge only: the inbox page reloads on these too, and none changes a row's preview.
    const inboxOnly = [
      "inbox.changed",
      "drafts.changed",
      "connectors.changed",
      "routines.changed",
      "memory.changed",
      "providers.changed",
      "approval.requested",
      "approval.resolved",
    ] as const;
    const off = peer
      ? [
          ...inboxOnly.map((event) => peer.on(event, () => schedule(none))),
          peer.on("bots.changed", () => schedule("all")),
          peer.on("groups.changed", (event) => schedule(new Set([`group:${event.groupId}`]))),
          peer.on("sidebar.changed", (event) =>
            schedule(event.conversationKey ? new Set([event.conversationKey]) : "all"),
          ),
          peer.on("chat.done", (event) => schedule(routeScope(event))),
          peer.on("chat.error", (event) => schedule(routeScope(event))),
        ]
      : [];
    if (peer)
      off.push(
        peer.on("chat.status", (status) => {
          statusRevision.current++;
          setData((previous) => {
            if (!scope.current.active || scope.current.peer !== peer) return previous;
            const statuses = applyStatus(previous.statuses, status);
            return { ...previous, statuses };
          });
        }),
      );
    return () => {
      scope.current.active = false;
      version.current++;
      lifetime.current.abort();
      pageLifetime.current.abort();
      clearTimeout(timer);
      for (const unsubscribe of off) unsubscribe();
    };
  }, [peer, reread]);
  return (
    <GroupCacheContext.Provider value={groupCache}>
      <WorkspaceContext.Provider value={{ ...data, refresh, more, moreBots, moreSections }}>
        {children}
      </WorkspaceContext.Provider>
    </GroupCacheContext.Provider>
  );
}
export function useGroupSessionCache() {
  const cache = useContext(GroupCacheContext);
  if (!cache) throw new Error("WorkspaceProvider is required");
  return cache;
}
