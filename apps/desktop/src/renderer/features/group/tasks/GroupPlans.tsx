import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { CollectionActions } from "../../execution/CollectionActions.tsx";
import executionStyles from "../../execution/execution.module.css";
import { useExecution } from "../../execution/workspace.tsx";
import styles from "../group.module.css";

export function GroupPlans() {
  const t = useT(),
    workspace = useExecution();
  const plans =
    workspace?.topics.filter(
      (topic) => topic.plan && (topic.plan.goal || topic.plan.items.length),
    ) ?? [];
  return (
    <section>
      <h3>{t("agentWork.planTitle")}</h3>
      {!plans.length && <p className={styles.note}>{t("execution.empty")}</p>}
      {plans.map((topic) => (
        <section key={topic.botId}>
          <div className={styles.taskDetailOwner}>
            <strong>{topic.name}</strong>
            {topic.plan && (
              <CollectionActions
                target={{
                  botId: topic.botId,
                  conversationId: topic.plan.conversationId,
                  kind: "plan",
                  expectedVersion: topic.plan.version,
                }}
                disabled={topic.error || topic.mutating}
              />
            )}
          </div>
          <p className={styles.taskInstructions}>{topic.plan?.goal}</p>
          {topic.plan?.items.map((item) => (
            <div key={item.id} className={executionStyles.step} data-state={item.status}>
              <button
                type="button"
                className={executionStyles.stepToggle}
                aria-label={t("execution.stepStatus", { title: item.title })}
                aria-pressed={item.status === "done"}
                disabled={topic.error || topic.mutating}
                onClick={() =>
                  void workspace?.changeStep(
                    topic.botId,
                    item.id,
                    item.status === "done" ? "pending" : "done",
                  )
                }
              >
                {item.status === "done" ? "✓" : item.status === "in_progress" ? "◔" : "○"}
              </button>
              <span>{item.title}</span>
            </div>
          ))}
          {topic.error && (
            <p role="alert" className={styles.error}>
              {t("execution.loadError")}{" "}
              <Button variant="ghost" onClick={workspace?.retry}>
                {t("common.retry")}
              </Button>
            </p>
          )}
        </section>
      ))}
    </section>
  );
}
