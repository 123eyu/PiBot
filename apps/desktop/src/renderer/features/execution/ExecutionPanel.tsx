import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import cardStyles from "./chat-cards.module.css";
import styles from "./execution.module.css";
import { planHeading } from "./PlanSteps.tsx";
import { useExecution } from "./workspace.tsx";

/** Only actionable progress belongs above the composer; details live in the side pane. */
export function ExecutionPanel() {
  const workspace = useExecution(),
    t = useT();
  if (!workspace) return null;
  return (
    <div className={styles.strips}>
      {workspace.topics.map((topic, index) => {
        const unfinished =
          topic.plan?.items.filter(
            (item) => item.status !== "done" && item.status !== "cancelled",
          ) ?? [];
        const running = topic.tasks.filter((task) =>
          ["queued", "running", "stopping"].includes(task.status),
        );
        if (
          !unfinished.length &&
          !running.length &&
          topic.settings?.mode !== "plan" &&
          !topic.error
        )
          return null;
        const current = unfinished.find((item) => item.status === "in_progress") ?? unfinished[0];
        const progress = planHeading(topic.plan, t);
        const label = [
          workspace.topics.length > 1 ? topic.name : "",
          progress,
          current?.title ?? "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={topic.botId}>
            {topic.settings?.mode === "plan" && (!workspace.groupId || index === 0) && (
              <div className={`${styles.planHint} ${cardStyles.planHint}`}>
                <Icon name="audit" size={14} />
                <span>{t("agentWork.planHint")}</span>
                <Button
                  variant="ghost"
                  disabled={topic.error || topic.mutating}
                  onClick={() => void workspace.changeMode(topic.botId, "execute")}
                >
                  {t("agentWork.executeInstead")}
                </Button>
              </div>
            )}
            {(unfinished.length > 0 || running.length > 0) && (
              <div className={`${styles.strip} ${cardStyles.strip}`}>
                {unfinished.length > 0 && (
                  <button
                    type="button"
                    className={styles.planSummary}
                    title={label}
                    aria-label={label}
                    onClick={() => workspace.revealPlan(topic.botId)}
                  >
                    {workspace.topics.length > 1 && (
                      <span className={styles.planMember}>{topic.name}</span>
                    )}
                    <span className={styles.planCount}>{progress}</span>
                    <span className={styles.planStep}>{current?.title}</span>
                    <Icon name="chevronRight" size={12} />
                  </button>
                )}
                {running.length > 0 && (
                  <button
                    type="button"
                    className={styles.childSummary}
                    onClick={() => workspace.open(topic.botId)}
                  >
                    {t("agentWork.runningChildren", { count: running.length })}
                  </button>
                )}
              </div>
            )}
            {topic.error && (
              <p role="alert" className={styles.error}>
                {t("execution.error")}{" "}
                <Button variant="ghost" onClick={workspace.retry}>
                  {t("common.retry")}
                </Button>
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
