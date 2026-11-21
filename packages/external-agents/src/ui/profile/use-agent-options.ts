import type { AgentAccountStatus, AgentSessionOptions } from "@pibot/external-agents-contract";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";

export type Change = { kind: "mode" | "model" | "config"; configId?: string; value: string };

const prewarmAt = new Map<string, number>();
const PREWARM_INTERVAL_MS = 10 * 60_000;

/** The options of a topic, or (no topic) of the Bot; refetched after the topic's turn ends. */
export function useAgentOptions(botId: string, conversationId?: string, enabled = true) {
  const { peer } = useRpc();
  const [options, setOptions] = useState<AgentSessionOptions>();
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [revision, setRevision] = useState(0);
  const [failed, setFailed] = useState<"refused" | "failed">();
  const [accountStatus, setAccountStatus] = useState<AgentAccountStatus>({
    kind: "unknown",
    checkedAt: null,
    command: null,
  });
  // The agent offers (or changes) its options during a turn: refetch when a run here ends.
  useRpcEvent("chat.done", (payload) => {
    if (payload.botId === botId && (!conversationId || payload.conversationId === conversationId))
      setRevision((value) => value + 1);
  });
  // The agent announces commands and option changes on its own, also between turns.
  useRpcEvent("externalAgents.optionsChanged", (payload) => {
    if (payload.botId === botId && (!conversationId || payload.conversationId === conversationId))
      setRevision((value) => value + 1);
  });
  useRpcEvent("externalAgents.statusChanged", (payload) => {
    if (payload.botId === botId) setAccountStatus(payload.status);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a refetch trigger.
  useEffect(() => {
    if (!peer || !enabled) return;
    const controller = new AbortController();
    peer
      .call(
        "externalAgents.sessionOptions",
        { botId, ...(conversationId ? { conversationId } : {}) },
        { signal: controller.signal },
      )
      .then(({ notices: next, ...result }) => {
        setOptions(result);
        setNotices(next);
      })
      .catch(() => {
        // Options are decoration: without them the form says the agent has not offered any yet.
        if (!controller.signal.aborted) setOptions(undefined);
      });
    return () => controller.abort();
  }, [peer, botId, conversationId, revision, enabled]);
  useEffect(() => {
    if (!peer || !enabled) return;
    const controller = new AbortController();
    peer
      .call(
        "externalAgents.checkStatus",
        { botId },
        { signal: controller.signal, timeoutMs: 20_000 },
      )
      .then((status) => {
        if (!controller.signal.aborted) setAccountStatus(status);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [peer, botId, enabled]);
  useEffect(() => {
    if (!peer || !conversationId || !enabled) return;
    const key = `${botId}:${conversationId}`;
    const now = Date.now();
    if (now - (prewarmAt.get(key) ?? 0) < PREWARM_INTERVAL_MS) return;
    prewarmAt.set(key, now);
    const controller = new AbortController();
    void peer
      .call("externalAgents.prewarm", { botId, conversationId }, { signal: controller.signal })
      // Best effort: a refused or failed prewarm only means the first turn starts the process.
      .catch(() => undefined);
    return () => controller.abort();
  }, [peer, botId, conversationId, enabled]);
  const change = useCallback(
    (value: Change) => {
      if (!peer) return Promise.resolve(false);
      setFailed(undefined);
      return peer
        .call(
          "externalAgents.setOption",
          { botId, ...(conversationId ? { conversationId } : {}), ...value },
          { timeoutMs: 20_000 },
        )
        .then((result) => {
          setOptions(result);
          return true;
        })
        .catch((error: unknown) => {
          setFailed(
            error instanceof Error && error.message === "agent_model_refused"
              ? "refused"
              : "failed",
          );
          setRevision((current) => current + 1);
          return false;
        });
    },
    [peer, botId, conversationId],
  );
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const checkStatus = useCallback(async () => {
    if (!peer || !conversationId) return;
    const next = await peer
      .call("externalAgents.checkStatus", { botId, force: true }, { timeoutMs: 20_000 })
      .catch(() => undefined);
    if (next) setAccountStatus(next);
  }, [peer, botId, conversationId]);
  return { options, notices, change, failed, refresh, accountStatus, checkStatus };
}
export type AgentOptionsState = ReturnType<typeof useAgentOptions>;
