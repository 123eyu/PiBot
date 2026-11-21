import type { ReplyCards } from "@pibot/client-core";
import type { Message } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, Icon, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import cardStyles from "./chat-cards.module.css";
import styles from "./execution.module.css";
import { GroupWorkflowDecisionCard } from "./GroupWorkflowDecisionCard.tsx";
import { MessageExecutionPause } from "./MessageExecutionPause.tsx";
import { marks, planHeading } from "./PlanSteps.tsx";
import { useExecution } from "./workspace.tsx";

/** The parent resolves all visible tool origins once, including reopened and paginated history. */
function ExecutionCards({ message, cards }: { message: Message; cards: ReplyCards | undefined }) {
  const workspace = useExecution(),
    { peer } = useRpc(),
    t = useT();
  const [stopping, setStopping] = useState<string>(),
    [error, setError] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: replacing the peer or source run cancels in-flight Stop receipts.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setStopping(undefined);
    setError(false);
    return () => controller.abort();
  }, [peer, message.botId, message.runId]);
  if (
    !workspace ||
    !message.botId ||
    !message.runId ||
    message.role !== "assistant" ||
    message.conversationId !== workspace.conversationId
  )
    return null;
  const topic = workspace.topics.find((entry) => entry.botId === message.botId);
  const tasks = cards?.tasks ?? [];
  const plan = cards?.plan;
  const completed = plan?.items.filter((item) => item.status === "done").length ?? 0;
  if (!tasks.length && !plan?.items.length) return null;
  const planCard = plan?.items.length ? (
    <section className={`${styles.inlineCard} ${cardStyles.card}`}>
      <div className={`${styles.cardHead} ${styles.planHeading}`}>
        <IconTile icon="menu" tone="amber" size="sm" />
        <b>
          {workspace.topics.length > 1
            ? t("agentWork.namedPlan", { name: topic?.name ?? "" })
            : t("agentWork.planTitle")}
        </b>
        {/* The chat card, the strip and the panel all read planHeading, so one plan shows
            the same "2/4 running" progress wherever it appears. */}
        <small className={styles.planCount}>{planHeading(plan, t)}</small>
      </div>
      {plan.goal && <p className={styles.inlinePlanGoal}>{plan.goal}</p>}
      <progress
        className={`${styles.planProgress} ${cardStyles.progress}`}
        aria-label={t("agentWork.planTitle")}
        value={completed}
        max={plan.items.length}
      />
      <div className={styles.inlinePlanSteps}>
        {plan.items.map((item) => (
          <div key={item.id} className={styles.step} data-state={item.status}>
            <span className={styles.stepMark} aria-hidden="true">
              {marks[item.status]}
            </span>
            <span>{item.title}</span>
          </div>
        ))}
      </div>
    </section>
  ) : null;
  if (!tasks.length) return planCard;
  return (
    <>
      {planCard}
      <section
        className={`${styles.inlineCard} ${cardStyles.card}`}
        aria-label={t("execution.children")}
      >
        <div className={styles.cardHead}>
          <IconTile icon="users" tone="amber" size="sm" />
          <b>{t("execution.children")}</b>
          <Chip tone="amber">{tasks.length}</Chip>
          <Button variant="ghost" onClick={() => workspace.open(topic?.botId)}>
            {t("agentWork.inSidePane")}
          </Button>
        </div>
        {tasks.map((task) => (
          <div key={task.id} className={styles.childRow} data-state={task.status}>
            <button
              type="button"
              className={styles.childOpen}
              onClick={() => workspace.open(task.botId, task.id)}
            >
              <span className={styles.statusDot} />
              <span>
                <b>{task.title}</b>
                <small>
                  {task.status === "stopping"
                    ? t("execution.stoppingHint")
                    : t(`execution.task.${task.status}`)}
                </small>
              </span>
              <Icon name="chevronRight" size={14} />
            </button>
            {["queued", "running"].includes(task.status) && (
              <Button
                variant="ghost"
                className={styles.childAction}
                disabled={!peer || !!stopping}
                onClick={() => {
                  const signal = lifetime.current?.signal;
                  if (!peer || !signal || signal.aborted) return;
                  setStopping(task.id);
                  setError(false);
                  void peer
                    .call(
                      "execution.tasks.cancel",
                      { botId: task.botId, conversationId: task.conversationId, taskId: task.id },
                      { timeoutMs: 10_000, signal },
                    )
                    .then(
                      () => {
                        if (!signal.aborted) setStopping(undefined);
                      },
                      () => {
                        if (!signal.aborted) {
                          setStopping(undefined);
                          setError(true);
                        }
                      },
                    );
                }}
              >
                {t("execution.stopTask")}
              </Button>
            )}
          </div>
        ))}
        {error && (
          <p role="alert">
            {t("execution.loadError")}{" "}
            <Button variant="ghost" onClick={() => workspace.open(topic?.botId)}>
              {t("agentWork.inSidePane")}
            </Button>
          </p>
        )}
      </section>
    </>
  );
}

export function MessageExecutionCards(props: { message: Message; cards: ReplyCards | undefined }) {
  return (
    <>
      <GroupWorkflowDecisionCard message={props.message} />
      <MessageExecutionPause message={props.message} />
      <ExecutionCards {...props} />
    </>
  );
}
