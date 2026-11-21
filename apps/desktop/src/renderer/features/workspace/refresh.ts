import { inboxTotal, readMainBot } from "@pibot/client-core";
import type { Bot, Group, InboxItem, SidebarEntry, SidebarGroup } from "@pibot/protocol";
import { optional, type Peer, type Summary, waitRpc } from "@pibot/renderer-kit";
import { recoverGroupStatuses } from "./group-status.ts";
import { hydrateEntries, summaries } from "./reads.ts";

export interface WorkspaceHeader {
  bots: Bot[];
  groups: Group[];
  entries: SidebarEntry[];
  sections: SidebarGroup[];
  archivedCount: number;
  unavailable: boolean;
  hasMore: boolean;
  hasMoreBots: boolean;
  hasMoreSections: boolean;
  botCursor?: string;
}
export async function readWorkspaceHeader(
  peer: Peer,
  parent: AbortSignal,
): Promise<WorkspaceHeader> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(30_000)]);
  const [catalog, groups, sidebar] = await Promise.all([
    waitRpc(() => peer.call("bots.list", { limit: 200 }, { signal }), signal),
    waitRpc(() => optional(peer.call("groups.list", { limit: 200 }, { signal })), signal),
    waitRpc(() => optional(peer.call("sidebar.list", { limit: 50 }, { signal })), signal),
  ]);
  signal.throwIfAborted();
  const bots = catalog.filter((bot) => !bot.archivedAt);
  return {
    bots,
    groups: groups ?? [],
    entries:
      sidebar?.entries ??
      bots.map((bot) => ({
        conversationKey: `dm:${bot.id}`,
        pinnedAt: null,
        groupId: null,
        hiddenAt: null,
        unread: false,
        lastReadAt: null,
      })),
    sections: sidebar?.groups ?? [],
    archivedCount: sidebar?.archivedCount ?? 0,
    unavailable: !sidebar,
    hasMore: sidebar?.entries.length === 50,
    hasMoreBots: catalog.length === 200,
    hasMoreSections: sidebar?.groups.length === 200,
    botCursor: catalog.at(-1)?.id,
  };
}
type DetailsPatch = {
  bots?: Bot[];
  groups?: Group[];
  inbox?: InboxItem[];
  inboxCount?: number;
  summaries?: Record<string, Summary>;
  unavailable?: boolean;
  detailsError?: boolean;
};
/**
 * `only` limits previews and run recovery to the rows that may have changed. Each row costs up to
 * three reads, so re-reading every row after every scoped event (opening a conversation, one Bot
 * finishing a reply) queued ~45 reads in front of the conversation being opened (2026-11-15).
 */
export async function readWorkspaceDetails(
  peer: Peer,
  header: WorkspaceHeader,
  parent: AbortSignal,
  ports: {
    current(): boolean;
    publish(patch: DetailsPatch): void;
    statusRevision(): number;
    statuses(
      value: Awaited<ReturnType<typeof recoverGroupStatuses>>,
      revision: number,
      keys: ReadonlySet<string>,
    ): void;
  },
  only?: ReadonlySet<string>,
) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(30_000)]);
  let bots = header.bots,
    groups = header.groups;
  let failed = false;
  const metadataJob = (async () => {
    const metadataRead = new AbortController();
    const metadataSignal = AbortSignal.any([signal, metadataRead.signal]);
    try {
      const [metadata, main] = await Promise.all([
        hydrateEntries(peer, header.entries, bots, groups, metadataSignal),
        bots.find((bot) => bot.isMain) ?? readMainBot(peer, metadataSignal),
      ]);
      signal.throwIfAborted();
      if (!ports.current()) return;
      if (main && !metadata.bots.some((bot) => bot.id === main.id)) metadata.bots.push(main);
      bots = metadata.bots;
      groups = metadata.groups;
      ports.publish(metadata);
    } catch {
      signal.throwIfAborted();
      if (ports.current()) {
        failed = true;
        ports.publish({ detailsError: true });
      }
    } finally {
      metadataRead.abort();
    }
  })();
  const inboxJob = (async () => {
    try {
      const [inbox, counts] = await Promise.all([
        waitRpc(() => optional(peer.call("inbox.list", { limit: 50 }, { signal })), signal),
        waitRpc(() => optional(peer.call("inbox.counts", undefined, { signal })), signal),
      ]);
      signal.throwIfAborted();
      if (ports.current())
        ports.publish({
          inbox: inbox ?? [],
          inboxCount: counts ? inboxTotal(counts) : (inbox?.length ?? 0),
          unavailable: header.unavailable || !inbox,
        });
    } catch {
      signal.throwIfAborted();
      if (ports.current()) {
        failed = true;
        ports.publish({ detailsError: true });
      }
    }
  })();
  // Previews and status need hydrated identities, but neither depends on inbox or each other.
  const detailsJob = metadataJob.then(async () => {
    signal.throwIfAborted();
    if (!ports.current()) return;
    const entries = only
      ? header.entries.filter((entry) => only.has(entry.conversationKey))
      : header.entries;
    const visible = new Set(entries.map((entry) => entry.conversationKey));
    const revision = ports.statusRevision();
    const completed = await Promise.allSettled([
      summaries(peer, entries, bots, groups, signal).then((previews) => {
        if (ports.current() && !signal.aborted) ports.publish({ summaries: previews });
      }),
      recoverGroupStatuses(
        peer,
        groups.filter((group) => visible.has(`group:${group.id}`)),
        signal,
        bots.filter((bot) => visible.has(`dm:${bot.id}`)),
      ).then((recovered) => {
        if (ports.current() && !signal.aborted) ports.statuses(recovered, revision, visible);
      }),
    ]);
    const failure = completed.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  // All admitted siblings settle before this refresh releases its lifetime.
  const settled = await Promise.allSettled([metadataJob, inboxJob, detailsJob]);
  signal.throwIfAborted();
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  if (ports.current()) ports.publish({ detailsError: failed });
}
