import type { ChatPeer } from "@pibot/client-core";
import type { Group, MethodResults } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "../group.module.css";

export function GroupBudget({
  peer,
  group,
  cycleId,
}: {
  peer: ChatPeer;
  group: Group;
  cycleId?: string | null;
}) {
  const t = useT(),
    [revision, refresh] = useState(0);
  const [value, setValue] = useState<{
    key: string;
    usage?: MethodResults["groups.execution.usage"];
    error: boolean;
  }>();
  const key = `${group.id}:${group.conversationId}:${cycleId ?? ""}`;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh((v) => v + 1), 500);
    };
    const off = [
      peer.on("execution.budget.changed", schedule),
      peer.on("groups.execution.changed", (event) => {
        if (event.groupId === group.id) schedule();
      }),
      peer.on("groups.changed", (event) => {
        if (event.groupId === group.id) schedule();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const stop of off) stop();
    };
  }, [peer, group.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: event revisions refresh the group's shared settings and current round.
  useEffect(() => {
    const controller = new AbortController();
    void peer
      .call(
        "groups.execution.usage",
        { groupId: group.id, conversationId: group.conversationId, cycleId },
        { signal: controller.signal, timeoutMs: 10000 },
      )
      .then(
        (usage) => {
          if (!controller.signal.aborted) setValue({ key, usage, error: false });
        },
        () => {
          if (!controller.signal.aborted)
            setValue((old) => ({
              key,
              ...(old?.key === key ? { usage: old.usage } : {}),
              error: true,
            }));
        },
      );
    return () => controller.abort();
  }, [peer, key, group.id, group.conversationId, cycleId, revision]);
  const current = value?.key === key ? value : undefined,
    usage = current?.usage;
  return (
    <section className={styles.groupBudget}>
      <h3>{t("execution.usage")}</h3>
      {current?.error && (
        <p role="alert" className={styles.error}>
          {t("execution.loadError")}{" "}
          <Button variant="ghost" onClick={() => refresh((v) => v + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!current && <p role="status">{t("common.loading")}</p>}
      {usage && (
        <>
          <p className={styles.note}>{t("group.groupUsageRoots", { count: usage.rootCount })}</p>
          <dl className={styles.groupUsage}>
            <div>
              <dt>{t("agentWork.tools")}</dt>
              <dd>{usage.totals.tools}</dd>
            </div>
            <div>
              <dt>{t("agentWork.requests")}</dt>
              <dd>{usage.totals.requests}</dd>
            </div>
            <div>
              <dt>{t("agentWork.time")}</dt>
              <dd>
                {t("agentWork.duration", {
                  minutes: Math.floor(usage.totals.activeMillis / 60000),
                  seconds: Math.floor(usage.totals.activeMillis / 1000) % 60,
                })}
              </dd>
            </div>
          </dl>
          {usage.totals.knownCostUsd > 0 && (
            <p className={styles.note}>
              {t("agentWork.knownCost", { cost: usage.totals.knownCostUsd.toFixed(4) })}
            </p>
          )}
          {usage.totals.unknownCostRequests > 0 && (
            <p className={styles.note}>
              {t("agentWork.unknownCost", { count: usage.totals.unknownCostRequests })}
            </p>
          )}
          {usage.totals.unknownUsageRequests > 0 && (
            <p className={styles.note}>
              {t("agentWork.unknownUsage", { count: usage.totals.unknownUsageRequests })}
            </p>
          )}
          {usage.totals.exhaustedRoots > (usage.totals.repeatedRoots ?? 0) && (
            <p className={styles.note}>
              {t("group.pastBudgetStops", {
                count: usage.totals.exhaustedRoots - (usage.totals.repeatedRoots ?? 0),
              })}
            </p>
          )}
          {(usage.totals.repeatedRoots ?? 0) > 0 && (
            <p className={styles.error}>{t("errors.repeated_operation")}</p>
          )}
        </>
      )}
      {/* The shared limits are edited in 群设置 (GroupLimits); this pane shows usage. */}
    </section>
  );
}
