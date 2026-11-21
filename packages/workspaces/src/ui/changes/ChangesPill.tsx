import { useT } from "@pibot/renderer-kit";
import styles from "./changes.module.css";
import { formatCount, pluralCount } from "./diff/FileList.tsx";
import { ChangesIcon } from "./icons.tsx";
import type { SourceState } from "./store.ts";

/** Header "+N −M": only for a Git primary folder with uncommitted changes. */
export function ChangesPill({
  state,
  open,
  toggle,
}: {
  state: SourceState;
  open: boolean;
  toggle(): void;
}) {
  const t = useT();
  const status = state.status;
  if (status?.git.state !== "repo" || status.root.role !== "primary" || status.total === 0)
    return null;
  const totals = status.totals;
  return (
    <button
      type="button"
      className={styles.headerPill}
      aria-pressed={open}
      aria-label={t("changes.pill.label", {
        count: status.total,
        added: totals?.added ?? 0,
        removed: totals?.removed ?? 0,
      })}
      title={t("changes.pill.title")}
      onClick={toggle}
    >
      <ChangesIcon name="branch" />
      {totals && (totals.added || totals.removed) ? (
        <>
          {!!totals.added && <span className={styles.plus}>+{formatCount(totals.added)}</span>}
          {!!totals.removed && <span className={styles.minus}>−{formatCount(totals.removed)}</span>}
        </>
      ) : (
        <span>{t("changes.list.files", { count: pluralCount(status.total) })}</span>
      )}
    </button>
  );
}
