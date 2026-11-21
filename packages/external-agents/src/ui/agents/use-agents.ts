import {
  type AgentBotSummary,
  AgentDetectionSchema,
  type DetectedAgent,
  type ExternalAgentMethodResults,
} from "@pibot/external-agents-contract";
import { useNavigation, useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";

export const AGENTS_REVISION = "externalAgents";
type Detection = ExternalAgentMethodResults["externalAgents.detect"];

/**
 * The last detection this window saw (W4 / Mac acceptance 16): right after a restart the brain can
 * take seconds to answer, and the cards should show what was found before, not "Checking…".
 * Programs and versions only; a stale copy is replaced by the fresh answer moments later.
 */
const CACHE_KEY = "pibot.externalAgents.detection";
function cachedDetection(): Detection | undefined {
  try {
    const parsed = AgentDetectionSchema.safeParse(
      JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Storage can be unavailable or hold an old shape: then the first answer is awaited.
    return undefined;
  }
}
function keepDetection(value: Detection) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // Only a convenience for the next start.
  }
}

/**
 * What the brain detected (it detects once in the background after start and keeps the result):
 * shown at once, cards update in place when the refresh this call starts finds a change.
 * `retry` waits for a fresh detection (after the user installed an agent).
 */
export function useAgents() {
  const { peer } = useRpc();
  const { revisions } = useNavigation();
  const revision = revisions[AGENTS_REVISION] ?? 0;
  const [detected, setDetected] = useState<Detection | undefined>(cachedDetection);
  const [state, setState] = useState<"loading" | "ready" | "failed">(() =>
    detected ? "ready" : "loading",
  );
  const [added, setAdded] = useState<AgentBotSummary[]>([]);
  const [listRevision, setListRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and attempt are refetch triggers.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    const refresh = attempt > 0;
    if (refresh) setRefreshing(true);
    else setState((value) => (value === "ready" ? value : "loading"));
    peer
      .call("externalAgents.detect", refresh ? { refresh: true } : {}, {
        signal: controller.signal,
        timeoutMs: 90_000,
      })
      .then((result) => {
        setDetected(result);
        keepDetection(result);
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((value) => (value === "ready" ? value : "failed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [peer, revision, attempt]);
  useRpcEvent("externalAgents.detected", (result) => {
    setDetected(result);
    keepDetection(result);
    setState("ready");
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: revisions are refetch triggers.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    peer
      .call("externalAgents.list", {}, { signal: controller.signal })
      .then((result) => setAdded(result.bots))
      .catch(() => {
        // The added list is secondary on these views; detection reports the failure state.
      });
    return () => controller.abort();
  }, [peer, revision, listRevision]);
  useRpcEvent("bots.changed", () => setListRevision((value) => value + 1));

  const agent = useCallback(
    (id: string): DetectedAgent | undefined => detected?.agents.find((item) => item.agentId === id),
    [detected],
  );
  return {
    state,
    isolation: detected?.isolation ?? "sandbox",
    agents: detected?.agents ?? [],
    agent,
    added,
    refreshing,
    retry: () => setAttempt((value) => value + 1),
  };
}
