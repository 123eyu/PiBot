import type { ChatPeer } from "@pibot/client-core";
import type { Group, MethodResults } from "@pibot/protocol";
import { useEffect, useState } from "react";

export function useGroupExecutionTasks(peer: ChatPeer, group: Group | undefined, revision: number) {
  const [limit, setLimit] = useState(50);
  const [state, setState] = useState<{
    key: string;
    page?: MethodResults["groups.execution.tasks"];
    error: boolean;
    busy: boolean;
  }>();
  const groupId = group?.id;
  const key = `${groupId}:${group?.conversationId}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: current-topic task events invalidate this bounded aggregate.
  useEffect(() => {
    if (!groupId) return;
    const controller = new AbortController();
    setState((old) =>
      old?.key === key ? { ...old, busy: true, error: false } : { key, busy: true, error: false },
    );
    void (async () => {
      let page: MethodResults["groups.execution.tasks"] | undefined, before: string | undefined;
      for (let count = 0; count < limit; count += 50) {
        const next = await peer.call(
          "groups.execution.tasks",
          { groupId, before, limit: 50 },
          { signal: controller.signal, timeoutMs: 10000 },
        );
        page = page ? { ...next, items: [...page.items, ...next.items] } : next;
        if (!next.nextBefore) break;
        if (before === next.nextBefore) throw new Error("group_task_cursor_stalled");
        before = next.nextBefore;
      }
      if (!controller.signal.aborted) setState({ key, page, busy: false, error: false });
    })().catch(() => {
      if (!controller.signal.aborted)
        setState((old) => ({
          key,
          ...(old?.key === key ? { page: old.page } : {}),
          busy: false,
          error: true,
        }));
    });
    return () => controller.abort();
  }, [peer, key, groupId, limit, revision]);
  const current = state?.key === key ? state : undefined;
  return {
    ...current,
    more: () => setLimit((v) => Math.min(200, v + 50)),
    hasMore: !!current?.page?.nextBefore && limit < 200,
  };
}
