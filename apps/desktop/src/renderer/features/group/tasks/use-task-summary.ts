import type { ChatPeer } from "@pibot/client-core";
import type { MethodResults } from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import type { TaskOrigin } from "./use-task-list.ts";

export function useTaskSummary(
  peer: ChatPeer,
  groupId: string,
  origin: TaskOrigin,
  conversationId?: string,
) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    peer: ChatPeer;
    key: string;
    summary?: MethodResults["groups.tasks.summary"];
    busy: boolean;
    error: boolean;
  }>();
  const key = `${groupId}:${conversationId ?? ""}:${origin}`;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 250);
    };
    const off = [
      peer.on("execution.task.changed", schedule),
      peer.on("approval.requested", schedule),
      peer.on("approval.resolved", schedule),
      peer.on("group.task", ({ task }) => {
        if (task.groupId === groupId) schedule();
      }),
      peer.on("groups.changed", (event) => {
        if (event.groupId === groupId) schedule();
      }),
      peer.on("chat.status", (event) => {
        if (event.groupId === groupId) schedule();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const dispose of off) dispose();
    };
  }, [peer, groupId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: durable events invalidate the shared count and list window
  useEffect(() => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    setState((previous) => ({
      peer,
      key,
      summary: previous?.peer === peer && previous.key === key ? previous.summary : undefined,
      busy: true,
      error: false,
    }));
    void waitRpc(
      () =>
        peer.call("groups.tasks.summary", {
          groupId,
          origin: origin === "all" ? undefined : origin,
        }),
      signal,
    )
      .then((summary) => {
        if (!signal.aborted) setState({ peer, key, summary, busy: false, error: false });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setState((previous) => previous && { ...previous, busy: false, error: true });
      });
    return () => abort.abort();
  }, [peer, groupId, origin, key, revision]);
  const current = state?.peer === peer && state.key === key ? state : undefined;
  return {
    summary: current?.summary,
    busy: current?.busy ?? true,
    error: current?.error ?? false,
    revision,
    retry: () => setRevision((value) => value + 1),
  };
}
