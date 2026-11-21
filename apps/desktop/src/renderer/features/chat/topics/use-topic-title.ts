import { chatReadCache } from "@pibot/client-core";
import { useRpc, useT } from "@pibot/renderer-kit";
import { routineTopicTitle } from "@pibot/routines/ui";
import { useCallback, useEffect, useState } from "react";

/** Topic metadata has no get method; page within the existing bounded lookup and cancel on leave. */
export function useTopicTitle(botId: string, conversationId: string | undefined, draft: boolean) {
  const { peer } = useRpc();
  const t = useT();
  const key = JSON.stringify([botId, conversationId, draft]);
  const reads = peer ? chatReadCache(peer) : undefined;
  const previewKey = JSON.stringify(["topic-title", botId, conversationId]);
  const [value, setValue] = useState<{ peer: typeof peer; key: string; title: string }>();
  const [error, setError] = useState(false),
    [revision, setRevision] = useState(0);
  // A scheduled task's topic is shown under the task's name (「调度任务：xxxx」).
  const shown = useCallback(
    (topic: { title?: string | null; routineId?: string | null }) =>
      topic.routineId ? routineTopicTitle(t, topic.title ?? "") : (topic.title ?? ""),
    [t],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries or invalidates the same scoped metadata.
  useEffect(() => {
    if (!peer || draft || !conversationId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError(true);
      controller.abort();
    }, 30000);
    setError(false);
    const off = peer.on("sidebar.changed", (event) => {
      if (event.conversationKey === `dm:${botId}`) setRevision((value) => value + 1);
    });
    void (async () => {
      let before: string | undefined;
      for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
        const page = await peer.call(
          "topics.list",
          { botId, before, limit: 200 },
          { signal: controller.signal, timeoutMs: 10000 },
        );
        controller.signal.throwIfAborted();
        for (const topic of page.slice(0, 8).toReversed())
          if (topic.botId === botId && topic.kind === "dm")
            reads?.rememberPreview(JSON.stringify(["topic-title", botId, topic.id]), shown(topic));
        const found = page.find(
          (topic) => topic.id === conversationId && topic.botId === botId && topic.kind === "dm",
        );
        if (found) {
          reads?.rememberPreview(previewKey, shown(found));
          setValue({ peer, key, title: shown(found) });
          return;
        }
        const next = page.at(-1)?.id;
        if (page.length < 200 || !next || next === before) break;
        before = next;
      }
      throw new Error("Topic metadata unavailable");
    })()
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
      off();
    };
  }, [peer, botId, conversationId, draft, key, revision, reads, previewKey, shown]);
  return {
    title:
      value?.peer === peer && value?.key === key ? value.title : reads?.preview<string>(previewKey),
    error,
    retry: () => setRevision((value) => value + 1),
  };
}
