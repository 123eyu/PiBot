import type { ExecutionSettings } from "@pibot/protocol";
import { botPanelStyles as styles, useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { useEffect, useState } from "react";
import { BudgetEditor } from "../../execution/BudgetEditor.tsx";

/**
 * This topic's run limits (cost cap included) in the Bot's「设置」tab. They used to sit at the
 * bottom of the task pane, which is greyed out while there are no tasks (maintainers 2026-10-22).
 * Limits are stored per Bot and topic, so the panel edits the topic that is open.
 */
export function BotLimits({ botId, conversationId }: { botId: string; conversationId: string }) {
  const { peer } = useRpc();
  const t = useT();
  const [settings, setSettings] = useState<ExecutionSettings>();
  const [saved, setSaved] = useState(false);
  // Autosave confirmation: a brief tag, not a line that stays.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);
  const [error, setError] = useState(false);
  const [revision, refresh] = useState(0);
  useRpcEvent("execution.changed", (event) => {
    if (event.botId === botId && event.conversationId === conversationId) setSettings(event);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` re-reads after a failure.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    setError(false);
    peer
      .call(
        "execution.get",
        { botId, conversationId },
        { signal: controller.signal, timeoutMs: 10_000 },
      )
      .then(
        (value) => {
          if (!controller.signal.aborted) setSettings(value);
        },
        () => {
          if (!controller.signal.aborted) setError(true);
        },
      );
    return () => controller.abort();
  }, [peer, botId, conversationId, revision]);
  const current =
    settings?.botId === botId && settings.conversationId === conversationId ? settings : undefined;
  return (
    <section className={styles.section}>
      <h2>{t("execution.limitsTitle")}</h2>
      {error && (
        <p role="alert" className={styles.error}>
          {t("execution.loadError")}{" "}
          <Button variant="pill" onClick={() => refresh((v) => v + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {saved && (
        <Chip tone="ok" role="status">
          {t("workspace.saved")}
        </Chip>
      )}
      {current && (
        <BudgetEditor
          key={`${botId}:${conversationId}`}
          settings={current}
          hint={t("execution.topicLimitsHint")}
          accept={(value) => {
            setSettings(value);
            setSaved(true);
          }}
        />
      )}
    </section>
  );
}
