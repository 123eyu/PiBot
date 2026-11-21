import type { TaskSummary } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Icon } from "@pibot/ui";
import { type ReactNode, useState } from "react";
import { TaskDetails } from "../../execution/TaskDetails.tsx";
import styles from "../group.module.css";

/** An absent parent remains a visible root until its page is loaded. */
export function ExecutionTaskTree({ tasks }: { tasks: readonly TaskSummary[] }) {
  const t = useT();
  const [selected, setSelected] = useState<string>();
  const ids = new Set(tasks.map((task) => task.id));
  const children = new Map<string | null, TaskSummary[]>();
  for (const task of tasks) {
    const parent = task.parentTaskId && ids.has(task.parentTaskId) ? task.parentTaskId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(task);
    children.set(parent, siblings);
  }
  const render = (task: TaskSummary, depth: number, ancestors: Set<string>): ReactNode => {
    if (ancestors.has(task.id) || depth > 5) return null;
    const seen = new Set(ancestors);
    seen.add(task.id);
    return (
      <li key={task.id} className={styles.executionTaskNode}>
        <button
          type="button"
          className={styles.task}
          aria-expanded={selected === task.id}
          onClick={() => setSelected(selected === task.id ? undefined : task.id)}
        >
          <Icon name={selected === task.id ? "chevron" : "chevronRight"} size={12} />
          <span className={styles.taskText}>
            <strong>{t(depth ? "group.taskNestedExecution" : "group.taskExecution")}</strong>
            <span>{task.title}</span>
          </span>
          <span
            className={styles.taskStatus}
            data-status={task.status === "interrupted" ? "error" : task.status}
          >
            {t(`execution.task.${task.status}`)}
          </span>
        </button>
        {selected === task.id && <TaskDetails key={task.id} task={task} readOnly />}
        {!!children.get(task.id)?.length && (
          <ul className={styles.executionTaskTree}>
            {children.get(task.id)?.map((child) => render(child, depth + 1, seen))}
          </ul>
        )}
      </li>
    );
  };
  return (
    <ul className={styles.executionTaskTree}>
      {(children.get(null) ?? []).map((task) => render(task, 0, new Set()))}
      {!children.get(null)?.length && tasks.length > 0 && <li>{t("group.taskTreeUnavailable")}</li>}
    </ul>
  );
}
