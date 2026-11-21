import type { ChangesTarget, WorktreeView } from "@pibot/workspaces-contract/full";
import { useEffect, useRef, useState } from "react";
import type { ManagedResourcesApi } from "./managed-resource-api.ts";
import { managedResourceErrorKey } from "./managed-resource-errors.ts";

/** Discovery pages stay separate from the task's execution and writable roots. */
export function useWorktreeViews(api: ManagedResourcesApi, target: ChangesTarget) {
  const [items, setItems] = useState<WorktreeView[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof managedResourceErrorKey>>();
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const paging = useRef(false);
  const key = JSON.stringify(target);
  // biome-ignore lint/correctness/useExhaustiveDependencies: canonical scope avoids identity-only reloads.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    paging.current = false;
    setItems([]);
    setBefore(null);
    setLoading(true);
    setError(undefined);
    void api
      .call(
        "worktrees.views",
        { target, limit: 20 },
        { signal: controller.signal, timeoutMs: 30_000 },
      )
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setItems(page.items);
          setBefore(page.nextBefore);
        },
        (error) => {
          if (!controller.signal.aborted) setError(managedResourceErrorKey(error));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, key, revision]);
  // File previews refresh on every matching change; root discovery only changes on folder changes.
  useEffect(
    () =>
      api.on?.("changes.changed", (event) => {
        if (
          event.reason === "folder" &&
          event.conversationKey === target.conversationKey &&
          (!event.topicId || event.topicId === target.topicId)
        )
          setRevision((value) => value + 1);
      }),
    [api, target.conversationKey, target.topicId],
  );
  const more = async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !before || loading || paging.current) return;
    paging.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const page = await api.call(
        "worktrees.views",
        { target, before, limit: 20 },
        { signal, timeoutMs: 30_000 },
      );
      if (signal.aborted) return;
      setItems((previous) => [
        ...new Map([...previous, ...page.items].map((item) => [item.rootId, item])).values(),
      ]);
      setBefore(page.nextBefore);
    } catch (error) {
      if (!signal.aborted) setError(managedResourceErrorKey(error));
    } finally {
      if (lifetime.current?.signal === signal) paging.current = false;
      if (!signal.aborted) setLoading(false);
    }
  };
  return { items, before, loading, error, more, refresh: () => setRevision((value) => value + 1) };
}
