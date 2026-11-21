import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask } from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";

export function useThread(
  peer: ChatPeer,
  groupId: string,
  threadId: string | undefined,
  tasks: GroupTask[],
) {
  const known = tasks.find(
    (task) => task.groupId === groupId && task.threadConversationId === threadId,
  );
  const [snapshot, setSnapshot] = useState<{
    peer: ChatPeer;
    groupId: string;
    threadId: string;
    task?: GroupTask;
    error: boolean;
  }>();
  const [revision, retry] = useState(0);
  const events = useRef(0);
  useEffect(
    () =>
      peer.on("group.task", ({ task }) => {
        if (threadId && task.groupId === groupId && task.threadConversationId === threadId) {
          events.current++;
          setSnapshot({ peer, groupId, threadId, task, error: false });
        }
      }),
    [peer, groupId, threadId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision requests a fresh bounded thread lookup
  useEffect(() => {
    if (!threadId || known) return;
    const update = (next: typeof snapshot) =>
      setSnapshot((previous) =>
        previous?.peer === peer &&
        previous.groupId === groupId &&
        previous.threadId === threadId &&
        previous.task &&
        previous.task.status !== "open"
          ? previous
          : next,
      );
    update(undefined);
    const started = events.current;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
    void (async () => {
      let before: string | undefined;
      for (let index = 0; index < 25; index++) {
        const page = await waitRpc(
          () => peer.call("groups.tasks", { groupId, before, limit: 200 }),
          signal,
        );
        signal.throwIfAborted();
        if (started !== events.current) return;
        const task = page.find(
          (task) => task.groupId === groupId && task.threadConversationId === threadId,
        );
        if (task) {
          update({ peer, groupId, threadId, task, error: false });
          return;
        }
        const next = page.at(-1)?.id;
        if (page.length < 200 || !next || next === before) break;
        before = next;
      }
      throw new Error("Thread unavailable within scan limit");
    })().catch(() => {
      if (!lifetime.signal.aborted && started === events.current)
        update({ peer, groupId, threadId, error: true });
    });
    return () => lifetime.abort();
  }, [peer, groupId, threadId, known, revision]);
  const current =
    snapshot?.peer === peer && snapshot.groupId === groupId && snapshot.threadId === threadId
      ? snapshot
      : undefined;
  return {
    task: current?.task && current.task.status !== "open" ? current.task : (known ?? current?.task),
    error: current?.error ?? false,
    retry: () => retry((v) => v + 1),
  };
}
