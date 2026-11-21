import { useT } from "@pibot/renderer-kit";
import type { ReviewFinding } from "@pibot/workspaces-contract/full";
import styles from "../changes.module.css";
import { ChangesIcon } from "../icons.tsx";
import { findingRef, severityLabel } from "./comments.ts";

export interface FindingActions {
  ignore(finding: ReviewFinding): void;
  fix(finding: ReviewFinding): void;
}

/** A review finding on its line: what is wrong, "Ignore" and "Fix this". */
export function FindingCard({
  finding,
  botName,
  actions,
  busy,
  inline,
  showRef,
}: {
  finding: ReviewFinding;
  botName: string;
  actions: FindingActions;
  busy: boolean;
  inline?: boolean;
  /** Cards outside their line (whole file / not on a shown line) name the line they refer to. */
  showRef?: boolean;
}) {
  const t = useT();
  return (
    <div
      className={styles.comment}
      data-inline={inline || undefined}
      data-finding={finding.severity}
      role="note"
    >
      <div className={styles.commentHead}>
        <ChangesIcon name="sparkle" size={13} />
        <b>{t("changes.review.by", { name: botName })}</b>
        {showRef && <span className={styles.commentRef}>{findingRef(t, finding)}</span>}
        <span className={styles.severity} data-severity={finding.severity}>
          {severityLabel(t, finding.severity)}
        </span>
      </div>
      <p className={styles.commentText}>{finding.message}</p>
      <p className={styles.commentText}>{t("agentReview.legacy")}</p>
      <div className={styles.commentActions}>
        <button
          type="button"
          className={styles.miniGhost}
          disabled={busy}
          onClick={() => actions.ignore(finding)}
        >
          {t("changes.review.ignore")}
        </button>
        <button
          type="button"
          className={styles.mini}
          disabled={busy}
          onClick={() => actions.fix(finding)}
        >
          {t("changes.review.fix")}
        </button>
      </div>
    </div>
  );
}
