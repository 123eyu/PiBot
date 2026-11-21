import type { ReviewSummary } from "@pibot/protocol";
import { useRpc, useSettings, useT, WorkspaceContext } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useContext, useState } from "react";
import { ReviewFindings } from "./ReviewFindings.tsx";
import styles from "./review-evidence.module.css";
import { useEvidenceRecord } from "./review-evidence-data.ts";

type Props = { summary: ReviewSummary; rootId?: string; revision: number };
export function ReviewEvidenceRecord({ summary, rootId, revision }: Props) {
  const { t, language } = useSettings(),
    [open, setOpen] = useState(false);
  // Mac acceptance: the record names who reviewed.
  const reviewerId = summary.reviewerBotId ?? summary.botId;
  const reviewer = useContext(WorkspaceContext)?.bots.find((bot) => bot.id === reviewerId)?.name;
  return (
    <article className={styles.row}>
      <Button
        variant="ghost"
        className={styles.recordSummary}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? "chevron" : "chevronRight"} size={13} />
        <span>{t(`agentReview.status.${summary.status}`)}</span>
        {reviewer && <span className={styles.hint}>{t("agentReview.by", { name: reviewer })}</span>}
        <span className={styles.hint}>
          {t("agentReview.findingsCount", { count: summary.findingsCount })}
        </span>
        <time className={styles.time} dateTime={summary.createdAt}>
          {new Date(summary.createdAt).toLocaleString(language)}
        </time>
      </Button>
      {open && <ReviewRecordDetails summary={summary} rootId={rootId} revision={revision} />}
    </article>
  );
}
function ReviewRecordDetails({ summary, rootId, revision }: Props) {
  const { peer } = useRpc(),
    t = useT(),
    [retry, setRetry] = useState(0);
  const record = useEvidenceRecord(
    peer,
    `${summary.botId}:${summary.conversationId}:${rootId ?? ""}:${summary.id}`,
    revision + retry,
    async (signal) => {
      if (!peer) throw new Error("Disconnected");
      const value = await peer.call(
        "reviewExecutions.get",
        { botId: summary.botId, conversationId: summary.conversationId, id: summary.id },
        { signal, timeoutMs: 20000 },
      );
      if (
        value.id !== summary.id ||
        value.botId !== summary.botId ||
        value.conversationId !== summary.conversationId ||
        value.snapshotHash !== summary.snapshotHash ||
        (rootId && value.rootId !== rootId)
      )
        throw new Error("Review scope mismatch");
      return value;
    },
  );
  const value = record.value;
  return (
    <div className={styles.recordDetails}>
      {record.busy && <p role="status">{t("common.loading")}</p>}
      {record.error && (
        <p role="alert" className={styles.error}>
          {t("agentReview.error")}{" "}
          <Button variant="ghost" onClick={() => setRetry((v) => v + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {value && (
        <>
          <p>{t(`agentReview.freshness.${value.freshness}`)}</p>
          <p>
            {t("agentReview.coverage", {
              files: value.coverage.capturedFiles,
              findings: value.findingsCount,
            })}
          </p>
          {!value.coverage.complete && <p className={styles.hint}>{t("agentReview.partial")}</p>}
          <ReviewFindings review={value} />
        </>
      )}
    </div>
  );
}
