import { agentDescriptor, type ExternalAgentMethodResults } from "@pibot/external-agents-contract";
import { useRpc, useT } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import styles from "../agents/agents.module.css";
import { UnisolatedBadge } from "./AgentIsolation.tsx";

type Info = ExternalAgentMethodResults["externalAgents.bot"];

/**
 * An agent Bot's 「资料」: what it is. Its settings, program, adapter and sandbox live in the
 * panel's Agent tab (maintainers 2026-11-14). No model, persona or memory: the agent has its own.
 */
export function AgentBotProfile({ botId }: { botId: string }) {
  const t = useT();
  const { peer } = useRpc();
  const [info, setInfo] = useState<Info>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    setFailed(false);
    peer
      .call("externalAgents.bot", { botId }, { signal: controller.signal, timeoutMs: 30_000 })
      .then(setInfo)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [peer, botId]);
  if (failed)
    return (
      <p role="alert" className={styles.error}>
        {t("errors.agent_unavailable")}
      </p>
    );
  if (!info)
    return (
      <p role="status" className={styles.note}>
        {t("common.loading")}
      </p>
    );
  const { bot } = info;
  const descriptor = bot.agentId === "custom" ? undefined : agentDescriptor(bot.agentId);
  const name = descriptor?.name ?? bot.name;
  const vendor = descriptor?.vendor ?? t("externalAgents.vendor.custom");
  return (
    <div className={styles.stack}>
      <p className={styles.note}>{t("externalAgents.profile.kind", { vendor })}</p>
      {/* W5: an unisolated agent says so wherever it appears. */}
      <UnisolatedBadge />
      <p className={styles.note}>{t("externalAgents.panel.moved", { name })}</p>
    </div>
  );
}
