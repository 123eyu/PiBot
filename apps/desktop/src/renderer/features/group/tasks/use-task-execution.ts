import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask, MethodResults } from "@pibot/protocol";
import { useEffect, useState } from "react";

export function useTaskExecution(peer: ChatPeer, task: GroupTask) {
  const [revision, refresh] = useState(0);
  const [limit, setLimit] = useState(50);
  const [value, setValue] = useState<{
    key: string;
    page?: MethodResults["groups.tasks.execution"];
    error: boolean;
    busy: boolean;
  }>();
  const key = `${task.groupId}:${task.id}`;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh((v) => v + 1), 250);
    };
    const off = [
      peer.on("execution.task.changed", (item) => {
        if (item.botId === task.assigneeBotId) schedule();
      }),
      peer.on("chat.status", (item) => {
        if (item.groupId === task.groupId) schedule();
      }),
      peer.on("chat.tool", (item) => {
        if (item.groupId === task.groupId && item.phase === "end") schedule();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const stop of off) stop();
    };
  }, [peer, task.groupId, task.assigneeBotId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: durable events invalidate this bounded task tree.
  useEffect(() => {
    const controller = new AbortController();
    setValue((old) =>
      old?.key === key ? { ...old, busy: true, error: false } : { key, busy: true, error: false },
    );
    void (async () => {
      let page: MethodResults["groups.tasks.execution"] | undefined;
      let before: string | undefined;
      for (let count = 0; count < limit; count += 50) {
        const next = await peer.call(
          "groups.tasks.execution",
          { groupId: task.groupId, taskId: task.id, before, limit: 50 },
          { signal: controller.signal, timeoutMs: 10000 },
        );
        page = page ? { ...next, items: [...page.items, ...next.items] } : next;
        if (!next.nextBefore) break;
        if (before === next.nextBefore) throw new Error("group_task_cursor_stalled");
        before = next.nextBefore;
      }
      if (!controller.signal.aborted) setValue({ key, page, busy: false, error: false });
    })().catch(() => {
      if (!controller.signal.aborted)
        setValue((old) => ({
          key,
          ...(old?.key === key ? { page: old.page } : {}),
          busy: false,
          error: true,
        }));
    });
    return () => controller.abort();
  }, [peer, key, task.groupId, task.id, revision, limit]);
  return {
    ...(value?.key === key ? value : { key, page: undefined, busy: true, error: false }),
    retry: () => refresh((v) => v + 1),
    more: () => setLimit((v) => Math.min(200, v + 50)),
    bounded: limit >= 200,
  };
}
