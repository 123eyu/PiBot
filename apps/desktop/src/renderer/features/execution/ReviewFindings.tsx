import type { MethodResults, ReviewSummary } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "./review-evidence.module.css";

/** This view has no fix action: findings attest only to the displayed immutable hash. */
export function ReviewFindings({ review }: { review: ReviewSummary }) {
  const { peer } = useRpc(),
    t = useT();
  const [open, setOpen] = useState(false),
    [revision, setRevision] = useState(0);
  const [result, setResult] = useState<MethodResults["reviewExecutions.findings"]>();
  const [error, setError] = useState(false),
    [loading, setLoading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly invalidates server-owned records after metadata events.
  useEffect(() => {
    if (!peer || !open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setResult(undefined);
    void peer
      .call(
        "reviewExecutions.findings",
        { botId: review.botId, conversationId: review.conversationId, id: review.id },
        { signal: controller.signal, timeoutMs: 20_000 },
      )
      .then(
        (value) => {
          if (controller.signal.aborted) return;
          if (value.snapshotHash !== review.snapshotHash || value.reviewId !== review.id) {
            setError(true);
            return;
          }
          setResult(value);
        },
        () => {
          if (!controller.signal.aborted) setError(true);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [peer, open, review.id, review.botId, review.conversationId, review.snapshotHash, revision]);
  return (
    <section>
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("agentReview.findings")}
      </Button>
      {open && (
        <>
          {loading && <p>{t("common.loading")}</p>}
          {error && (
            <p role="alert" className={styles.error}>
              {t("agentReview.error")}{" "}
              <Button variant="ghost" onClick={() => setRevision((r) => r + 1)}>
                {t("common.retry")}
              </Button>
            </p>
          )}
          {result && (
            <>
              <p>{t(`agentReview.freshness.${result.freshness}`)}</p>
              {!result.findings.length && <p>{t("agentReview.noFindings")}</p>}
              {result.findings.map((finding) => (
                <div className={styles.row} key={finding.id}>
                  <code>
                    {finding.path}
                    {finding.line ? `:${finding.line}` : ""}
                  </code>
                  <p>{finding.message}</p>
                </div>
              ))}
              {result.truncated && <p>{t("agentReview.partial")}</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}
