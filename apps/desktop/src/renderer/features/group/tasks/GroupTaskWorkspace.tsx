import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { type ReactNode, useState } from "react";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";
import { CurrentGroupPlan } from "./CurrentGroupPlan.tsx";
import { GroupBudget } from "./GroupBudget.tsx";
import { GroupPlanHistory } from "./GroupPlanHistory.tsx";
import { GroupTaskDetails } from "./GroupTaskDetails.tsx";
import { UnifiedGroupTasks } from "./UnifiedGroupTasks.tsx";
import type { useTaskSummary } from "./use-task-summary.ts";

export function GroupTaskWorkspace({
  peer,
  data,
  task,
  threadId,
  threadError,
  retryThread,
  openThread,
  refresh,
  taskSummary,
  selectedExecutionTask,
  children,
}: {
  peer: ChatPeer;
  data: GroupSnapshot;
  task?: GroupTask;
  threadId?: string;
  threadError: boolean;
  retryThread(): void;
  openThread(id?: string): void;
  refresh(): Promise<void>;
  taskSummary: ReturnType<typeof useTaskSummary>;
  selectedExecutionTask?: { botId: string; taskId: string };
  children?: ReactNode;
}) {
  const t = useT();
  // The live plan already shows above; history lists the earlier ones only.
  const [currentPlanId, setCurrentPlanId] = useState<string>();
  if (selectedExecutionTask) return children;
  if (threadId)
    return (
      <div className={styles.taskWorkspace}>
        <Button className={styles.taskBack} variant="ghost" onClick={() => openThread()}>
          <Icon name="chevronRight" size={14} style={{ transform: "rotate(180deg)" }} />
          {t("group.back")}
        </Button>
        {task ? (
          <GroupTaskDetails key={task.id} peer={peer} data={data} task={task} refresh={refresh} />
        ) : (
          <p role={threadError ? "alert" : "status"}>
            {t(threadError ? "group.deleted" : "common.loading")}
            {threadError && (
              <Button variant="ghost" onClick={retryThread}>
                {t("common.retry")}
              </Button>
            )}
          </p>
        )}
      </div>
    );
  return (
    <div className={styles.taskWorkspace}>
      {data.group && (
        <CurrentGroupPlan group={data.group} bots={data.bots} onCurrent={setCurrentPlanId} />
      )}
      {data.group && (
        <GroupPlanHistory
          key={`${data.group.id}:${data.group.conversationId}`}
          peer={peer}
          group={data.group}
          bots={data.bots}
          exclude={currentPlanId}
        />
      )}
      <UnifiedGroupTasks
        peer={peer}
        data={data}
        taskSummary={taskSummary}
        open={(task) => openThread(task.threadConversationId)}
      />
      {data.group && <GroupBudget peer={peer} group={data.group} cycleId={data.cycle?.cycleId} />}
    </div>
  );
}
