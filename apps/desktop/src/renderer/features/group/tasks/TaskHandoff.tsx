import { deliveryItemRow } from "@pibot/client-core";
import type { GroupTask } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import styles from "../group.module.css";

/** The sign-off status of a hand-off, shown next to the task's own status. */
export function HandoffState({ task }: { task: GroupTask }) {
  const t = useT();
  const handoff = task.handoff;
  if (!handoff) return null;
  return (
    <span className={styles.handoffState} data-state={handoff.state}>
      {t(`group.handoff.state.${handoff.state}`)}
    </span>
  );
}

/** What the coordinator asked back, how it is judged and the program's check. */
export function TaskHandoff({ task }: { task: GroupTask }) {
  const t = useT();
  const handoff = task.handoff;
  if (!handoff) return null;
  return (
    <section className={styles.handoff} aria-label={t("group.handoff.title")}>
      <div className={styles.handoffHead}>
        <span>{t("group.handoff.title")}</span>
        <HandoffState task={task} />
      </div>
      {handoff.returnOf && <p className={styles.note}>{t("group.handoff.returnOf")}</p>}
      <dl className={styles.handoffList}>
        {handoff.workflow && (
          <>
            <dt>{t("group.handoff.workflow")}</dt>
            <dd>{handoff.workflow}</dd>
          </>
        )}
        {handoff.files.length > 0 && (
          <>
            <dt>{t("group.handoff.files")}</dt>
            <dd>
              {handoff.files.map((file) => (
                <code key={file}>{file}</code>
              ))}
            </dd>
          </>
        )}
        {handoff.form && (
          <>
            <dt>{t("group.handoff.form")}</dt>
            <dd>{handoff.form}</dd>
          </>
        )}
        {handoff.acceptance.length > 0 && (
          <>
            <dt>{t("group.handoff.acceptance")}</dt>
            <dd>
              {handoff.acceptance.map((item) => item.text ?? item.id).join(t("group.handoff.sep"))}
            </dd>
          </>
        )}
        {handoff.condition && (
          <>
            <dt>{t("group.handoff.condition")}</dt>
            <dd>{handoff.condition}</dd>
          </>
        )}
      </dl>
      {handoff.items.length > 0 && (
        <ul className={styles.handoffItems} aria-label={t("group.handoff.check")}>
          {handoff.items.map((item) => {
            const row = deliveryItemRow(item, t);
            const confirmed = item.status === "manual" && handoff.userConfirmed;
            return (
              <li key={item.id} data-tone={confirmed ? "ok" : row.tone}>
                <span className={styles.handoffCheckIcon} aria-hidden="true">
                  {confirmed || row.tone === "ok" ? "✓" : row.tone === "danger" ? "✕" : "·"}
                </span>
                <span className={styles.handoffCheckLabel}>{row.label}</span>
                {row.tone === "danger" && (
                  <span className={styles.handoffCheckReason}>{row.value}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {handoff.artifacts.length > 0 && (
        <p className={styles.note}>
          {t("group.handoff.artifacts")}
          {handoff.artifacts.map((file) => (
            <code key={file}>{file}</code>
          ))}
        </p>
      )}
    </section>
  );
}
