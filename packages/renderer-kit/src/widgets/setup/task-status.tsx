import styles from "./setup.module.css";
import type { useTask } from "./use-task.ts";

export function TaskStatus({
  task,
}: {
  task: Pick<ReturnType<typeof useTask>, "error" | "success">;
}) {
  return (
    <>
      {task.error && (
        <p role="alert" className={styles.error}>
          {task.error}
        </p>
      )}
      {task.success && (
        <p role="status" className={styles.success}>
          {task.success}
        </p>
      )}
    </>
  );
}
