import type { TodoPlan } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { useLayoutEffect, useRef, useState } from "react";
import styles from "./execution.module.css";

type Status = TodoPlan["items"][number]["status"];

/** Same marks as the group plan card's progress lines, so one plan reads alike everywhere. */
export const marks: Record<Status, string> = {
  done: "✓",
  in_progress: "●",
  pending: "○",
  cancelled: "–",
};

/** 「计划 · 1/3 进行中」 names the running step's position; otherwise done out of total. */
export function planHeading(plan: TodoPlan | undefined, t: ReturnType<typeof useT>): string {
  const items = plan?.items ?? [];
  if (!items.length) return t("agentWork.planTitle");
  const current = items.findIndex((item) => item.status === "in_progress");
  return current >= 0
    ? t("execution.progressRunning", { current: current + 1, total: items.length })
    : t("execution.progress", {
        done: items.filter((item) => item.status === "done").length,
        total: items.length,
      });
}

export function PlanSteps({
  plan,
  disabled,
  changeStep,
}: {
  plan: TodoPlan;
  disabled?: boolean;
  changeStep(id: string, status: Status): void;
}) {
  const t = useT();
  return (
    <div className={styles.planCard}>
      {!!plan.goal && <p className={styles.planGoal}>{plan.goal}</p>}
      {plan.items.map((item) => (
        <div className={`${styles.step} ${styles.planStep}`} key={item.id} data-state={item.status}>
          <button
            type="button"
            className={styles.stepToggle}
            aria-label={t("execution.stepStatus", { title: item.title })}
            aria-pressed={item.status === "done"}
            title={t(`execution.${item.status}`)}
            disabled={disabled}
            onClick={() => changeStep(item.id, item.status === "done" ? "pending" : "done")}
          >
            {marks[item.status]}
          </button>
          <StepText title={item.title} />
          {item.status !== "done" && item.status !== "cancelled" && (
            // The only step action is skip; a one-item menu behind faint dots was easy to miss.
            <button
              type="button"
              className={styles.stepSkip}
              disabled={disabled}
              aria-label={t("agentWork.skipStep")}
              onClick={() => changeStep(item.id, "cancelled")}
            >
              {t("execution.skip")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Long steps clamp to two lines; only a step that actually overflows becomes a button, so short
 * steps add no extra tab stops. Re-measured on resize because widening the pane can unclamp it.
 */
function StepText({ title }: { title: string }) {
  const t = useT();
  const node = useRef<HTMLElement | null>(null);
  const attach = (element: HTMLElement | null) => {
    node.current = element;
  };
  const [expanded, setExpanded] = useState(false),
    [clamped, setClamped] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `title` and `clamped` swap the measured node.
  useLayoutEffect(() => {
    const element = node.current;
    if (!element || expanded) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, title, clamped]);
  if (!clamped && !expanded)
    return (
      <span ref={attach} className={styles.stepText}>
        {title}
      </span>
    );
  return (
    <button
      ref={attach}
      type="button"
      className={styles.stepText}
      data-expanded={expanded || undefined}
      aria-expanded={expanded}
      title={t(expanded ? "execution.collapseStep" : "execution.expandStep")}
      onClick={() => setExpanded((value) => !value)}
    >
      {title}
    </button>
  );
}
