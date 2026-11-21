import type { TranslationKey } from "@pibot/i18n";
import { useSettings } from "@pibot/renderer-kit";
import type { SkillUpdatePending } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { useMemo } from "react";
import styles from "./skills.module.css";

/** A diff of 500-line files is already 250k cells; the dialog only needs a readable frame. */
const DIFF_MAX_LINES = 600;
/** Beyond this the DOM cost outweighs the value; the rest is reported as truncated. */
const DIFF_MAX_ROWS = 300;
const CONTEXT_LINES = 2;

// `id` is a generation counter, not an array index: repeated identical lines need distinct keys.
type Row = { id: number; kind: "same" | "add" | "del"; text: string };

/**
 * Line diff for the update dialog. The summary counts files only, so the user must see whether the
 * instructions (the part the model reads) changed at all — a bigger package can ship the same steps.
 */
export function diffRows(before: string, after: string): { rows: Row[]; truncated: boolean } {
  const a = before.split("\n").slice(0, DIFF_MAX_LINES);
  const b = after.split("\n").slice(0, DIFF_MAX_LINES);
  const width = b.length + 1;
  // Longest common subsequence from the end, so a forward walk can pick the edit script in order.
  const dp = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i * width + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
  const all: Row[] = [];
  let seq = 0;
  const push = (kind: Row["kind"], text: string) => {
    all.push({ id: seq++, kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i] ?? "");
      i++;
      j++;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      push("del", a[i] ?? "");
      i++;
    } else {
      push("add", b[j] ?? "");
      j++;
    }
  }
  for (; i < a.length; i++) push("del", a[i] ?? "");
  for (; j < b.length; j++) push("add", b[j] ?? "");
  // Unchanged head and tail would bury the edits; keep two lines of context around the changes.
  const first = all.findIndex((row) => row.kind !== "same");
  const last = all.findLastIndex((row) => row.kind !== "same");
  const rows =
    first === -1
      ? []
      : all.slice(
          Math.max(0, first - CONTEXT_LINES),
          Math.min(all.length, last + CONTEXT_LINES + 1),
        );
  const truncated =
    before.split("\n").length > DIFF_MAX_LINES ||
    after.split("\n").length > DIFF_MAX_LINES ||
    rows.length > DIFF_MAX_ROWS;
  return { rows: rows.slice(0, DIFF_MAX_ROWS), truncated };
}

export function SkillUpdateDialog({
  name,
  fromVersion,
  pending,
  busy,
  error,
  keep,
  apply,
}: {
  name: string;
  fromVersion: string | null;
  pending: SkillUpdatePending;
  busy: boolean;
  error?: TranslationKey;
  keep(): void;
  apply(): void;
}) {
  const { t } = useSettings();
  const summary = pending.summary;
  const diff = useMemo(
    () => diffRows(summary.skillTextBefore, summary.skillTextAfter),
    [summary.skillTextBefore, summary.skillTextAfter],
  );
  return (
    <div className={styles.overlay} role="presentation">
      <div
        className={`${styles.dialog} ${styles.wideDialog}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("skills.update.dialog.titleUnversioned", { name })}
      >
        <h2>
          {pending.version
            ? t("skills.update.dialog.title", { name, version: pending.version })
            : t("skills.update.dialog.titleUnversioned", { name })}
        </h2>
        <p className={styles.kv}>
          <span>{t("skills.update.dialog.fromTo")}</span>
          <span>
            {fromVersion ?? "—"} → {pending.version ?? "—"}
          </span>
        </p>
        <p className={styles.kv}>
          <span>{t("skills.update.dialog.files")}</span>
          <span>
            {t("skills.update.dialog.filesValue", {
              added: summary.added,
              modified: summary.modified,
              removed: summary.removed,
              before: summary.filesBefore,
              after: summary.filesAfter,
            })}
          </span>
        </p>
        <h3 className={styles.subhead}>{t("skills.update.dialog.skillMd")}</h3>
        {diff.rows.length === 0 ? (
          <p className={styles.note}>{t("skills.update.dialog.skillMdSame")}</p>
        ) : (
          <ol className={styles.diff}>
            {diff.rows.map((row) => (
              <li key={row.id} className={styles.diffRow} data-kind={row.kind}>
                <span className={styles.diffMark}>
                  {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
                </span>
                {row.text}
              </li>
            ))}
          </ol>
        )}
        {diff.truncated && (
          <p className={styles.note}>
            {t("skills.update.dialog.truncated", { chars: summary.skillTextAfter.length })}
          </p>
        )}
        <p className={styles.note}>
          {summary.runtimeNeedsPreparation
            ? t("skills.update.dialog.runtimeChanged")
            : t("skills.update.dialog.runtimeSame")}
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button variant="ghost" disabled={busy} onClick={keep}>
            {t("skills.update.dialog.keep")}
          </Button>
          <Button variant="primary" loading={busy} onClick={apply}>
            {t("skills.update.dialog.apply")}
          </Button>
        </div>
      </div>
    </div>
  );
}
