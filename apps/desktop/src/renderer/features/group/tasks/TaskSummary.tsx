import type { GroupTask } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import styles from "../group.module.css";

export function TaskSummary({ task }: { task: GroupTask }) {
  const t = useT();
  if (!task.summary?.trim()) return null;
  return (
    <details className={styles.taskFold}>
      <summary>{t("group.taskSummary")}</summary>
      <p className={styles.taskInstructions}>{task.summary}</p>
    </details>
  );
}
