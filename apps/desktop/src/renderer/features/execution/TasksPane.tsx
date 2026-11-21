import { useT } from "@pibot/renderer-kit";
import { Button, Icon, IconTile, StatusDot } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { BackgroundCommands } from "./BackgroundCommands.tsx";
import { BudgetPanel } from "./BudgetPanel.tsx";
import { CollectionActions } from "./CollectionActions.tsx";
import { ExecutionArchive } from "./ExecutionArchive.tsx";
import styles from "./execution.module.css";
import { PlanSteps, planHeading } from "./PlanSteps.tsx";
import { TaskDetails } from "./TaskDetails.tsx";
import { taskDot } from "./task-look.ts";
import { useExecution } from "./workspace.tsx";

export function TasksPane({
  selected,
  back,
}: {
  selected?: { botId: string; taskId: string };
  back(): void;
}) {
  const workspace = useExecution(),
    t = useT();
  const root = useRef<HTMLDivElement>(null),
    prior = useRef<string | undefined>(undefined),
    handledReveal = useRef(0);
  const [flashed, setFlashed] = useState<string>();
  const reveal = workspace?.planReveal;
  useEffect(() => {
    if (selected?.taskId) root.current?.querySelector<HTMLElement>("button")?.focus();
    else if (prior.current)
      root.current
        ?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(prior.current)}"]`)
        ?.focus();
    prior.current = selected?.taskId;
  }, [selected?.taskId]);
  // The pane may mount before its plan loads, so retry on topic updates until an anchor exists.
  // Scrolling happens next frame: opening the pane focuses its first button, which would otherwise
  // pull the list back to the top after this effect ran.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a loaded plan is only visible through the rendered anchors.
  useEffect(() => {
    if (!reveal || reveal.nonce === handledReveal.current) return;
    const selector = `[data-plan-anchor="${CSS.escape(reveal.botId)}"]`,
      target =
        root.current?.querySelector<HTMLElement>(selector) ??
        root.current?.querySelector<HTMLElement>(`[data-topic="${CSS.escape(reveal.botId)}"]`);
    if (!target) return;
    handledReveal.current = reveal.nonce;
    setFlashed(reveal.botId);
    const frame = window.requestAnimationFrame(() => target.scrollIntoView({ block: "start" })),
      timer = window.setTimeout(() => setFlashed(undefined), 1600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [reveal, workspace?.topics]);
  if (!workspace) return null;
  const task =
    selected &&
    workspace.topics
      .find((topic) => topic.botId === selected.botId)
      ?.tasks.find((entry) => entry.id === selected.taskId);
  if (task)
    return (
      <div ref={root} className={styles.taskPane}>
        <div className={styles.toolbar}>
          <Button variant="ghost" onClick={back}>
            <Icon name="chevronRight" style={{ transform: "rotate(180deg)" }} />
            {t("agentWork.backToTasks")}
          </Button>
          <CollectionActions
            target={{
              botId: task.botId,
              conversationId: task.conversationId,
              kind: "task",
              id: task.id,
              expectedVersion: task.version,
            }}
            disabled={["queued", "running", "stopping"].includes(task.status)}
          />
        </div>
        <TaskDetails key={task.id} task={task} />
      </div>
    );
  return (
    <div ref={root} className={styles.taskPane}>
      {!workspace.topics.length && <p role="status">{t("common.loading")}</p>}
      {workspace.topics.map((topic) => (
        <section key={topic.botId} className={styles.topic} data-topic={topic.botId}>
          {workspace.topics.length > 1 && <h3>{topic.name}</h3>}
          <BackgroundCommands botId={topic.botId} conversationId={workspace.conversationId} />
          {topic.loading && <p role="status">{t("common.loading")}</p>}
          {topic.error && (
            <p role="alert">
              {t("execution.loadError")}{" "}
              <Button variant="ghost" onClick={workspace.retry}>
                {t("common.retry")}
              </Button>
            </p>
          )}
          {topic.plan && (topic.plan.items.length > 0 || !!topic.plan.goal) && (
            <div
              className={`${styles.planArea} ${flashed === topic.botId ? styles.planReveal : ""}`}
              data-plan-anchor={topic.botId}
            >
              <div className={styles.toolbar}>
                <h3 className={styles.collectionTitle} data-tone="amber">
                  {planHeading(topic.plan, t)}
                </h3>
                <CollectionActions
                  icon="chevron"
                  showLabel
                  disabled={topic.error || topic.mutating}
                  target={{
                    botId: topic.botId,
                    conversationId: topic.plan.conversationId,
                    kind: "plan",
                    expectedVersion: topic.plan.version,
                  }}
                />
              </div>
              <PlanSteps
                plan={topic.plan}
                disabled={topic.error || topic.mutating}
                changeStep={(id, status) => void workspace.changeStep(topic.botId, id, status)}
              />
            </div>
          )}
          {!topic.plan?.items.length &&
            !topic.plan?.goal &&
            !topic.tasks.length &&
            !topic.loading &&
            !topic.error && (
              <div role="status" className={styles.paneEmpty}>
                <IconTile icon="plan" tone="amber" size="lg" className={styles.paneEmptyTile} />
                <b>{t("execution.noPlanOrTasks")}</b>
                <p>{t("sidePane.empty.tasks")}</p>
              </div>
            )}
          {!!topic.tasks.length && <h3 data-tone="blue">{t("execution.children")}</h3>}
          <div className={styles.taskList}>
            {topic.tasks.map((task) => (
              <div className={styles.collectionRow} key={task.id}>
                <button
                  className={styles.taskRow}
                  data-state={task.status}
                  data-task-id={task.id}
                  type="button"
                  onClick={() => workspace.open(topic.botId, task.id)}
                >
                  <StatusDot state={taskDot(task.status)} />
                  <span>
                    <b>{task.title}</b>
                    <small>{t(`execution.task.${task.status}`)}</small>
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
                <CollectionActions
                  disabled={topic.error || ["queued", "running", "stopping"].includes(task.status)}
                  target={{
                    botId: task.botId,
                    conversationId: task.conversationId,
                    kind: "task",
                    id: task.id,
                    expectedVersion: task.version,
                  }}
                />
              </div>
            ))}
          </div>
          {topic.next && topic.tasks.length < 100 && (
            <Button
              variant="ghost"
              disabled={topic.loading}
              onClick={() => void workspace.older(topic.botId)}
            >
              {t("execution.older")}
            </Button>
          )}
          {topic.tasks.length >= 100 && <p className={styles.hint}>{t("execution.listBound")}</p>}
          {workspace.conversationId && (
            <ExecutionArchive botId={topic.botId} conversationId={workspace.conversationId} />
          )}
          {topic.settings && <BudgetPanel settings={topic.settings} />}
        </section>
      ))}
    </div>
  );
}
