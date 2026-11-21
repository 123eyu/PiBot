import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import type { WorkflowSummary } from "@pibot/skills-contract/full";
import { useCallback, useEffect, useState } from "react";

export function useWorkflows(botId: string | undefined, groupId?: string) {
  const { peer } = useRpc();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    items: WorkflowSummary[];
    loading: boolean;
    error: boolean;
  }>({ items: [], loading: !!botId, error: false });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useRpcEvent("skills.changed", (event) => {
    if (event.botId === botId && event.groupId === groupId && event.reason !== "proposed")
      refresh();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly requests a reload.
  useEffect(() => {
    if (!peer || !botId) {
      setState({ items: [], loading: false, error: false });
      return;
    }
    const abort = new AbortController();
    setState((current) => ({ ...current, loading: true, error: false }));
    void peer
      .call("skills.workflows", { botId, groupId }, { signal: abort.signal })
      .then(({ items }) => {
        if (!abort.signal.aborted) setState({ items, loading: false, error: false });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ items: [], loading: false, error: true });
      });
    return () => abort.abort();
  }, [peer, botId, groupId, revision]);

  return { ...state, refresh };
}
