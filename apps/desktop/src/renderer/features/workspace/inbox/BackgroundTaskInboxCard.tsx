import { failureReasonKey } from "@pibot/i18n";
import type { InboxItem } from "@pibot/protocol";
import { useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { useRoutineNavigation } from "@pibot/routines/ui";
import { Button } from "@pibot/ui";
import { useState } from "react";
import styles from "./inbox.module.css";

export type BackgroundTaskInboxItem = Extract<InboxItem, { kind: "background_task" }>;

/**
 * The card that turns a silent background failure into something the person can act on.
 * It shows the task and current object name alongside a fixed reason and next step.
 */
export function BackgroundTaskInboxCard({ item }: { item: BackgroundTaskInboxItem }) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const [busy, setBusy] = useState(false);
  const { openSettings } = useNavigation();
  const { openRoutines } = useRoutineNavigation();
  const { task, subject, subjectName, reasonCode, streak, firstFailedAt } = item.health;
  const title = t("workspace.backgroundTask");
  const model = task === "memory_extraction" || task === "memory_organization";
  const reason = failureReasonKey(reasonCode);
  return (
    <article className={styles.card} aria-label={title}>
      <header className={styles.cardHeader}>
        <div className={styles.heading}>
          <strong>{title}</strong>
          {subjectName && <div>{subjectName}</div>}
        </div>
        <span className={styles.badge}>{t(`workspace.backgroundTask.task.${task}`)}</span>
      </header>
      <div className={styles.memoryBody}>
        <p>
          {t("workspace.backgroundTask.streak", { count: streak })} ·{" "}
          {t("workspace.backgroundTask.since", {
            time: new Date(firstFailedAt).toLocaleString(language),
          })}
        </p>
        <p>
          {t("workspace.backgroundTask.reason", {
            // Known failure codes read as a sentence; an unknown one stays a code for the log.
            code: reason ? t(reason) : reasonCode,
          })}
        </p>
        <p>{t(`workspace.backgroundTask.action.${task}`)}</p>
        <p>{t("workspace.backgroundTask.note")}</p>
      </div>
      <div className={styles.links}>
        <Button
          variant="ghost"
          disabled={busy || !peer}
          title={t("workspace.backgroundTaskDismissHint")}
          onClick={() => {
            if (!peer) return;
            setBusy(true);
            void peer
              .call("inbox.dismissBackgroundTask", { task, subject, reasonCode })
              .finally(() => setBusy(false));
          }}
        >
          {t("workspace.backgroundTaskDismiss")}
        </Button>
        {model ? (
          <Button onClick={() => openSettings("models")}>
            {t("workspace.backgroundTaskModels")}
          </Button>
        ) : task === "routine_run" ? (
          <Button onClick={() => openRoutines(subjectName ? subject : undefined)}>
            {t("workspace.backgroundTaskRoutines")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
