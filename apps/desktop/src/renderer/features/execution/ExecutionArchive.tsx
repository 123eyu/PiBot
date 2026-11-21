import type { ArchivedPlan, ExecutionScope, TaskSummary } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon, IconTile, StatusDot } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { CollectionActions } from "./CollectionActions.tsx";
import styles from "./execution.module.css";
import { TaskDetails } from "./TaskDetails.tsx";
import { taskDot } from "./task-look.ts";

function PlanSnapshot({ plan }: { plan: ArchivedPlan }) {
  const t = useT(),
    [open, setOpen] = useState(false);
  return (
    <article className={styles.planCard}>
      <div className={styles.toolbar}>
        <b className={styles.collectionTitle}>{plan.goal || t("agentWork.planTitle")}</b>
        <CollectionActions
          archived
          target={{
            kind: "plan",
            id: plan.id,
            botId: plan.botId,
            conversationId: plan.conversationId,
            expectedVersion: plan.version,
          }}
        />
      </div>
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("execution.progress", {
          done: plan.items.filter((item) => item.status === "done").length,
          total: plan.items.length,
        })}
        <Icon
          name="chevronRight"
          size={14}
          style={open ? { transform: "rotate(90deg)" } : undefined}
        />
      </Button>
      {open &&
        plan.items.map((item) => (
          <div key={item.id} className={styles.step} data-state={item.status}>
            <span>{item.title}</span>
            <small>{t(`execution.${item.status}`)}</small>
          </div>
        ))}
    </article>
  );
}

function ArchivedEntries({ scope }: { scope: ExecutionScope }) {
  const { peer } = useRpc(),
    t = useT();
  const { botId, conversationId } = scope;
  const [plans, setPlans] = useState<ArchivedPlan[]>([]),
    [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [nextPlans, setNextPlans] = useState<string | null>(null),
    [nextTasks, setNextTasks] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(false),
    [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string>();
  const lifetime = useRef<AbortController | undefined>(undefined),
    lock = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision reloads this scope after a collection event or explicit retry.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    lifetime.current = controller;
    lock.current = false;
    setLoading(true);
    setError(false);
    const options = { signal: controller.signal, timeoutMs: 10000 };
    const off = peer.on("execution.collection.changed", (event) => {
      if (event.botId === botId && event.conversationId === conversationId)
        setRevision((value) => value + 1);
    });
    void Promise.all([
      peer.call("execution.plans.archived", { botId, conversationId, limit: 25 }, options),
      peer.call(
        "execution.tasks.list",
        { botId, conversationId, archived: true, limit: 25 },
        options,
      ),
    ])
      .then(
        ([planPage, taskPage]) => {
          if (controller.signal.aborted) return;
          setPlans(planPage.items);
          setTasks(taskPage.items);
          setNextPlans(planPage.nextBefore);
          setNextTasks(taskPage.nextBefore);
        },
        () => {
          if (!controller.signal.aborted) setError(true);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      off();
    };
  }, [peer, botId, conversationId, revision]);
  const older = async (kind: "plan" | "task") => {
    const signal = lifetime.current?.signal,
      before = kind === "plan" ? nextPlans : nextTasks;
    if (!peer || !signal || signal.aborted || !before || loading || lock.current) return;
    lock.current = true;
    setLoading(true);
    setError(false);
    try {
      if (kind === "plan") {
        const page = await peer.call(
          "execution.plans.archived",
          { ...scope, before, limit: 25 },
          { signal, timeoutMs: 10000 },
        );
        if (!signal.aborted) {
          setPlans((current) =>
            [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()].slice(
              0,
              100,
            ),
          );
          setNextPlans(page.nextBefore);
        }
      } else {
        const page = await peer.call(
          "execution.tasks.list",
          { ...scope, archived: true, before, limit: 25 },
          { signal, timeoutMs: 10000 },
        );
        if (!signal.aborted) {
          setTasks((current) =>
            [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()].slice(
              0,
              100,
            ),
          );
          setNextTasks(page.nextBefore);
        }
      }
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      lock.current = false;
      if (!signal.aborted) setLoading(false);
    }
  };
  const task = tasks.find((item) => item.id === selected);
  return (
    <div className={styles.archiveList}>
      {loading && <p role="status">{t("common.loading")}</p>}
      {error && (
        <p role="alert">
          {t("execution.loadError")}{" "}
          <Button variant="ghost" onClick={() => setRevision((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {task ? (
        <>
          <div className={styles.toolbar}>
            <Button variant="ghost" onClick={() => setSelected(undefined)}>
              {t("execution.backToArchive")}
            </Button>
            <CollectionActions
              archived
              disabled={loading || error}
              target={{ ...scope, kind: "task", id: task.id, expectedVersion: task.version }}
            />
          </div>
          <TaskDetails key={task.id} task={task} />
        </>
      ) : (
        <>
          <h3>
            {t("agentWork.planTitle")}
            {plans.length > 0 && ` · ${plans.length}${nextPlans ? "+" : ""}`}
          </h3>
          {!plans.length && !loading && !error && (
            <p className={styles.hint}>{t("execution.noArchivedPlans")}</p>
          )}
          {!loading && !error && plans.map((plan) => <PlanSnapshot key={plan.id} plan={plan} />)}
          {nextPlans && plans.length < 100 && (
            <Button variant="ghost" disabled={loading} onClick={() => void older("plan")}>
              {t("execution.older")}
            </Button>
          )}
          <h3>
            {t("execution.children")}
            {tasks.length > 0 && ` · ${tasks.length}${nextTasks ? "+" : ""}`}
          </h3>
          {!tasks.length && !loading && !error && (
            <p className={styles.hint}>{t("execution.noArchivedTasks")}</p>
          )}
          {!loading && !error && tasks.length > 0 && (
            <div className={styles.taskList}>
              {tasks.map((item) => (
                <div className={styles.collectionRow} key={item.id}>
                  <button
                    className={styles.taskRow}
                    type="button"
                    onClick={() => setSelected(item.id)}
                  >
                    <StatusDot state={taskDot(item.status)} />
                    <span>
                      <b>{item.title}</b>
                      <small>{t(`execution.task.${item.status}`)}</small>
                    </span>
                    <Icon name="chevronRight" size={14} />
                  </button>
                  <CollectionActions
                    archived
                    target={{ ...scope, kind: "task", id: item.id, expectedVersion: item.version }}
                  />
                </div>
              ))}
            </div>
          )}
          {nextTasks && tasks.length < 100 && (
            <Button variant="ghost" disabled={loading} onClick={() => void older("task")}>
              {t("execution.older")}
            </Button>
          )}
          {(plans.length >= 100 || tasks.length >= 100) && (
            <p className={styles.hint}>{t("execution.listBound")}</p>
          )}
        </>
      )}
    </div>
  );
}

export function ExecutionArchive({ botId, conversationId }: ExecutionScope) {
  const [open, setOpen] = useState(false),
    t = useT();
  return (
    <>
      {/* The archive is a soft row led by its teal tile; counts show in the list below. */}
      <button
        type="button"
        className={styles.archiveToggle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <IconTile icon="archive" tone="teal" />
        <span className={styles.archiveLabel}>
          {t(open ? "execution.closeArchive" : "execution.openArchive")}
        </span>
        <Icon
          name="chevronRight"
          size={14}
          style={open ? { transform: "rotate(90deg)" } : undefined}
        />
      </button>
      {open && (
        <ArchivedEntries key={`${botId}:${conversationId}`} scope={{ botId, conversationId }} />
      )}
    </>
  );
}
