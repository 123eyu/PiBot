import type { BudgetSnapshot, ExecutionSettings } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "./execution.module.css";

export function BudgetPanel({ settings }: { settings: ExecutionSettings }) {
  const t = useT();
  const { peer } = useRpc();
  const [budget, setBudget] = useState<BudgetSnapshot | null>();
  const [refresh, setRefresh] = useState(0);
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the current scope.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    let revision = 0;
    const scope = { botId: settings.botId, conversationId: settings.conversationId };
    const load = () => {
      const request = ++revision;
      void peer
        .call("execution.budget.get", scope, { signal: controller.signal, timeoutMs: 10_000 })
        .then(
          (value) => {
            if (!controller.signal.aborted && request === revision) {
              setBudget((current) =>
                current && value?.rootRunId === current.rootRunId && current.version > value.version
                  ? current
                  : value,
              );
              setFailed(false);
            }
          },
          () => {
            if (!controller.signal.aborted && request === revision) setFailed(true);
          },
        );
    };
    const off = [
      peer.on("execution.budget.changed", (value) =>
        setBudget((current) =>
          current?.rootRunId === value.rootRunId && value.version >= current.version
            ? value
            : current,
        ),
      ),
      peer.on("chat.status", (value) => {
        if (value.botId === scope.botId && value.conversationId === scope.conversationId) load();
      }),
    ];
    load();
    return () => {
      controller.abort();
      for (const stop of off) stop();
    };
  }, [peer, settings.botId, settings.conversationId, refresh]);
  return (
    <div className={`${styles.steps} ${styles.budgetCard}`}>
      <strong data-tone="green">{t("execution.usage")}</strong>
      {failed ? (
        <p role="alert">
          {t("execution.loadError")}{" "}
          <Button variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      ) : budget === undefined ? (
        <p>{t("common.loading")}</p>
      ) : budget === null ? (
        <p className={styles.hint}>{t("execution.noUsage")}</p>
      ) : (
        <>
          <div className={styles.statGrid}>
            {(
              [
                [
                  "agentWork.tools",
                  budget.tools,
                  budget.limits.toolCalls,
                  String(budget.tools),
                  String(budget.limits.toolCalls),
                ],
                [
                  "agentWork.requests",
                  budget.requests,
                  budget.limits.modelRequests,
                  String(budget.requests),
                  String(budget.limits.modelRequests),
                ],
                [
                  "agentWork.time",
                  budget.activeMillis / 1000,
                  budget.limits.activeSeconds,
                  t("agentWork.duration", {
                    minutes: Math.floor(budget.activeMillis / 60000),
                    seconds: Math.floor(budget.activeMillis / 1000) % 60,
                  }),
                  t("agentWork.duration", {
                    minutes: Math.floor(budget.limits.activeSeconds / 60),
                    seconds: budget.limits.activeSeconds % 60,
                  }),
                ],
              ] as const
            ).map(([label, used, max, value, limit]) => (
              <div key={label} className={`${styles.meter} ${styles.statTile}`}>
                <b>{value}</b>
                <span>
                  {t(label)} · {t("agentWork.limitOf", { limit })}
                </span>
                <progress aria-label={t(label)} value={Math.min(used, max)} max={max} />
              </div>
            ))}
          </div>
          {(budget.requests > budget.unknownCostRequests || budget.knownCostUsd > 0) && (
            <p className={styles.hint}>
              {t("agentWork.knownCost", { cost: budget.knownCostUsd.toFixed(4) })}
            </p>
          )}
          {budget.unknownCostRequests > 0 && (
            <p className={styles.hint}>
              {t("agentWork.unknownCost", { count: budget.unknownCostRequests })}
            </p>
          )}
          {budget.unknownUsageRequests > 0 && (
            <p className={styles.hint}>
              {t("agentWork.unknownUsage", { count: budget.unknownUsageRequests })}
            </p>
          )}
          {budget.exhaustedReason && (
            <p className={styles.error}>
              {t(
                budget.exhaustedReason === "repeated_operation"
                  ? "errors.repeated_operation"
                  : "errors.budget_exhausted",
              )}
            </p>
          )}
        </>
      )}
      {/* The limits themselves are edited in the Bot's「设置」tab (BotLimits). */}
    </div>
  );
}
