import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useState } from "react";
import { DeliveryEvidenceRecord } from "./DeliveryEvidenceRecord.tsx";
import { ReviewEvidenceRecord } from "./ReviewEvidenceRecord.tsx";
import styles from "./review-evidence.module.css";
import { useEvidencePages } from "./review-evidence-data.ts";

type Props = {
  botId: string;
  conversationId: string;
  rootId?: string;
  expanded?: boolean;
  hideTitle?: boolean;
};
export function ReviewEvidencePanel(props: Props) {
  return (
    <Evidence key={`${props.botId}:${props.conversationId}:${props.rootId ?? ""}`} {...props} />
  );
}
function Evidence({ botId, conversationId, rootId, expanded = false, hideTitle = false }: Props) {
  const { peer } = useRpc(),
    t = useT();
  const [localOpen, setLocalOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [revision, refresh] = useState(0);
  const open = expanded || localOpen;
  const scope = { botId, conversationId },
    key = `${botId}:${conversationId}:${rootId ?? ""}`;
  useEffect(() => {
    if (!peer) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh((v) => v + 1), 250);
    };
    const changed = (value: { botId?: string; conversationId?: string }) => {
      if (
        value.botId === botId &&
        (!value.conversationId || value.conversationId === conversationId)
      )
        schedule();
    };
    const off = [
      peer.on("review.execution.changed", changed),
      peer.on("delivery.evidence.changed", changed),
      peer.on("chat.done", changed),
      peer.on("changes.changed", schedule),
    ];
    return () => {
      clearTimeout(timer);
      for (const stop of off) stop();
    };
  }, [peer, botId, conversationId]);
  const reviews = useEvidencePages(
    peer,
    `reviews:${key}`,
    open,
    revision,
    async (before, signal) => {
      if (!peer) throw new Error("Disconnected");
      const page = await peer.call(
        "reviewExecutions.list",
        { ...scope, ...(rootId ? { rootId } : {}), before, limit: 10 },
        { signal, timeoutMs: 20000 },
      );
      if (
        page.items.some(
          (item) =>
            item.botId !== botId ||
            item.conversationId !== conversationId ||
            (rootId && item.rootId !== rootId),
        )
      )
        throw new Error("Review list scope mismatch");
      return page;
    },
  );
  const history = useEvidencePages(
    peer,
    `history:${key}`,
    open && historyOpen,
    revision,
    async (before, signal) => {
      if (!peer) throw new Error("Disconnected");
      const page = await peer.call(
        "deliveryEvidence.list",
        { ...scope, before, limit: 20 },
        { signal, timeoutMs: 20000 },
      );
      if (page.items.some((item) => item.botId !== botId || item.conversationId !== conversationId))
        throw new Error("Evidence list scope mismatch");
      return page;
    },
  );
  const earlier = (
    records: { items: unknown[]; next?: string | null; busy: boolean; more(): Promise<void> },
    label: string,
  ) =>
    records.next &&
    records.items.length < 200 && (
      <Button variant="ghost" disabled={records.busy} onClick={() => void records.more()}>
        {label}
      </Button>
    );
  const historyItems = history.items.filter(
    (entry) => entry.kind !== "review" || (!!rootId && entry.review.rootId !== rootId),
  );
  return (
    <section className={styles.panel}>
      {!hideTitle &&
        (expanded ? (
          <h3 className={styles.title}>{t("agentReview.title")}</h3>
        ) : (
          <Button variant="ghost" aria-expanded={open} onClick={() => setLocalOpen((v) => !v)}>
            <Icon name={open ? "chevron" : "chevronRight"} size={14} />
            {t("agentReview.title")}
          </Button>
        ))}
      {open && (
        <div className={styles.body}>
          <section
            aria-label={t(rootId ? "agentReview.workspaceReviews" : "agentReview.topicReviews")}
          >
            <h3 className={styles.title}>
              {t(rootId ? "agentReview.workspaceReviews" : "agentReview.topicReviews")}
            </h3>
            <p className={styles.hint}>{t("agentReview.metadataNotProof")}</p>
            {reviews.busy && <p role="status">{t("common.loading")}</p>}
            {reviews.error && (
              <p role="alert" className={styles.error}>
                {t("agentReview.error")}{" "}
                <Button variant="ghost" onClick={() => refresh((v) => v + 1)}>
                  {t("common.retry")}
                </Button>
              </p>
            )}
            {!reviews.busy && !reviews.error && !reviews.items.length && (
              <p className={styles.hint}>{t("agentReview.noWorkspaceReviews")}</p>
            )}
            {reviews.items.map((summary) => (
              <ReviewEvidenceRecord
                key={summary.id}
                summary={summary}
                rootId={rootId}
                revision={revision}
              />
            ))}
            {earlier(reviews, t("agentReview.moreReviews"))}
            {reviews.next && reviews.items.length >= 200 && (
              <p className={styles.hint}>{t("agentReview.pageBound")}</p>
            )}
          </section>
          <section className={styles.history}>
            <Button
              variant="ghost"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <Icon name={historyOpen ? "chevron" : "chevronRight"} size={14} />
              {t("agentReview.topicHistory")}
            </Button>
            {historyOpen && (
              <div className={styles.historyBody}>
                <p className={styles.hint}>{t("agentReview.historyNotWorkspaceProof")}</p>
                {history.busy && <p role="status">{t("common.loading")}</p>}
                {history.error && (
                  <p role="alert" className={styles.error}>
                    {t("agentReview.error")}{" "}
                    <Button variant="ghost" onClick={() => refresh((v) => v + 1)}>
                      {t("common.retry")}
                    </Button>
                  </p>
                )}
                {!history.busy && !history.error && !historyItems.length && (
                  <p className={styles.hint}>{t("agentReview.noTopicRecords")}</p>
                )}
                {historyItems.map((entry) => (
                  <DeliveryEvidenceRecord key={entry.id} entry={entry} revision={revision} />
                ))}
                {earlier(history, t("agentReview.more"))}
                {history.next && history.items.length >= 200 && (
                  <p className={styles.hint}>{t("agentReview.pageBound")}</p>
                )}
              </div>
            )}
          </section>
          <p className={styles.hint}>{t("agentReview.noPass")}</p>
        </div>
      )}
    </section>
  );
}
