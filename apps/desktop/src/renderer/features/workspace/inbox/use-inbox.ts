import { type InboxGroup, inboxGroupMatches, inboxGroupPage } from "@pibot/client-core";
import type { EventPayloads, InboxItem, MethodResults } from "@pibot/protocol";
import { useRpc, waitRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

export type InboxKind = InboxGroup;
export type InboxDisplayItem = InboxItem & { providerConnected?: true };
const emptyCounts = { approval: 0, memory: 0, provider: 0 };
export function useInbox(kind?: InboxKind) {
  const { peer } = useRpc();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [receipts, setReceipts] = useState<InboxDisplayItem[]>([]);
  const [counts, setCounts] = useState<MethodResults["inbox.counts"]>(emptyCounts);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const loaded = useRef(items);
  loaded.current = items;
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const record = useCallback((item: InboxDisplayItem) => {
    if (item.kind === "personal_todo") {
      const previous = loaded.current.find(
        (old) => old.kind === "personal_todo" && old.todo.id === item.todo.id,
      );
      if (previous?.kind === "personal_todo" && previous.todo.status !== item.todo.status) {
        const delta = item.todo.status === "open" ? 1 : -1;
        setCounts((current) => ({
          ...current,
          personal_todo: Math.max(0, (current.personal_todo ?? 0) + delta),
        }));
      }
      // Completed to-dos belong in Personal to-dos, not in the pending receipt history.
      // Invalidate an older list response before removing the acknowledged item.
      epoch.current++;
      request.current?.abort();
      setReceipts((previous) =>
        previous.filter((old) => old.kind !== "personal_todo" || old.todo.id !== item.todo.id),
      );
      setItems((previous) =>
        previous.flatMap((old) =>
          old.kind === "personal_todo" && old.todo.id === item.todo.id
            ? item.todo.status === "open"
              ? [item]
              : []
            : [old],
        ),
      );
      return;
    }
    setReceipts((previous) =>
      [item, ...previous.filter((old) => old.cursor !== item.cursor)].slice(0, 100),
    );
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new peer cannot inherit receipts or counters from the previous connection.
  useEffect(() => {
    setItems([]);
    setReceipts([]);
    setCounts(emptyCounts);
  }, [peer]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const owner = new AbortController();
    let proposalsRunning = false;
    let proposalTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshProposals = async () => {
      if (!peer || proposalsRunning || !active) return;
      proposalsRunning = true;
      const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]);
      try {
        // Receipt retention is bounded to the same 100 rows as record(); requests run serially.
        for (const item of loaded.current
          .filter((row) => row.kind === "routine_proposal")
          .slice(0, 100)) {
          if (item.kind !== "routine_proposal") continue;
          const items = await waitRpc(
            () => peer.call("routines.proposals", { id: item.proposal.id }),
            signal,
          );
          const proposal = items[0];
          if (
            active &&
            proposal &&
            proposal.id === item.proposal.id &&
            proposal.botId === item.proposal.botId &&
            proposal.status !== "open"
          )
            record({ ...item, proposal });
        }
      } catch {
        if (active) setError(true);
      } finally {
        proposalsRunning = false;
        if (active) changed();
      }
    };
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(reload, 250);
    };
    const resolved = (event: EventPayloads["approval.resolved"]) => {
      const item = loaded.current.find(
        (item) =>
          (item.kind === "approval" || item.kind === "routine_approval") &&
          item.approval.id === event.id,
      );
      if (item?.kind === "approval" || item?.kind === "routine_approval")
        record({
          ...item,
          approval: { ...item.approval, status: event.status, remembered: event.remembered },
        });
      changed();
    };
    const off = [
      peer?.on("inbox.changed", changed),
      peer?.on("execution.question.answered", changed),
      peer?.on("chat.done", changed),
      peer?.on("chat.message", changed),
      peer?.on("drafts.changed", changed),
      peer?.on("connectors.changed", changed),
      peer?.on("routines.changed", () => {
        clearTimeout(proposalTimer);
        proposalTimer = setTimeout(() => void refreshProposals(), 200);
        changed();
      }),
      peer?.on("approval.resolved", resolved),
      // A card answered in the chat (or timed out) stays here as its result line.
      peer?.on("chat.notice", (notice) => {
        if (notice.kind !== "computer_handoff" || notice.status === "pending") return;
        const item = loaded.current.find(
          (row) => row.kind === "computer_handoff" && row.notice.id === notice.id,
        );
        if (item?.kind === "computer_handoff") record({ ...item, notice });
      }),
      peer?.on("memory.changed", (event) => {
        changed();
        if (event.reason !== "resolved" || !event.proposalId) return;
        const item = loaded.current.find(
          (item) =>
            item.kind === "memory" &&
            item.proposal.id === event.proposalId &&
            item.proposal.botId === event.botId,
        );
        if (item?.kind !== "memory" || !peer) return;
        void peer
          .call("bots.profile", { botId: event.botId })
          .then((profile) => {
            const proposal =
              profile.bot.id === event.botId
                ? profile.proposals.find(
                    (proposal) =>
                      proposal.id === event.proposalId && proposal.botId === event.botId,
                  )
                : undefined;
            if (active && proposal && proposal.status !== "pending") record({ ...item, proposal });
          })
          .catch(() => {
            if (active) setError(true);
          });
      }),
      peer?.on("providers.changed", changed),
      peer?.on("providers.loginState", (event) => {
        changed();
        if (event.state !== "connected") return;
        const item = loaded.current.find(
          (item) => item.kind === "provider" && item.providerId === event.providerId,
        );
        if (item) record({ ...item, providerConnected: true });
      }),
    ];
    return () => {
      active = false;
      owner.abort();
      clearTimeout(proposalTimer);
      clearTimeout(timer);
      for (const unsubscribe of off) unsubscribe?.();
    };
  }, [peer, reload, record]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision triggers event refresh and explicit retry.
  useEffect(() => {
    const version = ++epoch.current;
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    setError(false);
    setMore(false);
    if (peer)
      void Promise.all([
        inboxGroupPage(
          (params) => peer.call("inbox.list", params, { signal: abort.signal, timeoutMs: 30_000 }),
          kind,
          undefined,
          abort.signal,
        ),
        peer.call("inbox.counts", undefined, { signal: abort.signal, timeoutMs: 30_000 }),
      ])
        .then(([next, counts]) => {
          if (version !== epoch.current) return;
          setItems(next);
          setCounts(counts);
          setMore(next.length === 50);
        })
        .catch(() => {
          if (version === epoch.current) setError(true);
        })
        .finally(() => {
          if (version === epoch.current) setLoading(false);
        });
    else setLoading(false);
    return () => {
      epoch.current++;
      abort.abort();
    };
  }, [peer, kind, revision]);
  const loadMore = async () => {
    if (!peer || loading || !more) return;
    const version = epoch.current;
    setLoading(true);
    setError(false);
    try {
      const signal = request.current?.signal;
      if (!signal) return;
      const next = await inboxGroupPage(
        (params) => peer.call("inbox.list", params, { signal, timeoutMs: 30_000 }),
        kind,
        items.at(-1)?.cursor,
        signal,
      );
      if (version === epoch.current) {
        setItems((previous) => {
          const ids = new Set(previous.map((item) => item.cursor));
          return [...previous, ...next.filter((item) => !ids.has(item.cursor))];
        });
        setMore(next.length === 50);
      }
    } catch {
      if (version === epoch.current) setError(true);
    } finally {
      if (version === epoch.current) setLoading(false);
    }
  };
  const forget = (cursor: string) => {
    setReceipts((old) => old.filter((item) => item.cursor !== cursor));
    setItems((old) => old.filter((item) => item.cursor !== cursor));
  };
  const resolved = receipts.filter((item) => inboxGroupMatches(kind, item));
  const resolvedIds = new Set(resolved.map((item) => item.cursor));
  return {
    items: [
      ...items.filter((item) => inboxGroupMatches(kind, item) && !resolvedIds.has(item.cursor)),
      ...resolved,
    ],
    counts,
    loading,
    more,
    error,
    revision,
    reload,
    loadMore,
    record,
    forget,
  };
}
