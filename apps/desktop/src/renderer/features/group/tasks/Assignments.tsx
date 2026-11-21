import type { GroupTask, Message, MethodResults } from "@pibot/protocol";
import { botAvatarLook, useT } from "@pibot/renderer-kit";
import { Chip, type Tone } from "@pibot/ui";
import type { ActivityState } from "../../chat/tools/local-activity.ts";
import { RunApprovals } from "../../execution/RunApprovals.tsx";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";

type Summary = MethodResults["groups.tasks.summary"];
/** Chips have no tint for the muted avatar colours; those members read as neutral. */
export function memberTone(color: string): Tone {
  return color === "brown" || color === "ink" || color === "gray" ? "neutral" : (color as Tone);
}
export function assignmentPresentation(
  message: Message,
  activity: ActivityState,
  assigned: boolean,
  collaborating: boolean,
  focusToolCallId?: string,
) {
  const visible = (tool: {
    tool: string;
    status: string;
    toolCallId: string;
    approval?: { status: string };
  }) =>
    tool.status !== "done" ||
    (!!tool.approval && tool.approval.status !== "allowed") ||
    tool.toolCallId === focusToolCallId ||
    (!(tool.tool === "assign_task" && assigned) && !(tool.tool === "ask_bot" && collaborating));
  const records = message.tools?.filter(visible);
  const live = activity.tools.filter(visible);
  return {
    message: records?.length === message.tools?.length ? message : { ...message, tools: records },
    activity: live.length === activity.tools.length ? activity : { ...activity, tools: live },
  };
}
export function GroupAssignments({
  batch,
  collaborations,
  bots,
  openTasks,
  openTask,
  tasks,
  groupName,
  onUserBubble = false,
}: {
  batch?: Summary["batches"][number];
  collaborations?: Summary["collaborations"];
  name: string;
  bots: GroupSnapshot["bots"];
  openTasks?: () => void;
  openTask?: (threadId: string) => void;
  tasks?: GroupTask[];
  groupName?: string;
  onUserBubble?: boolean;
}) {
  const t = useT();
  // G-main: task lines under a message are soft 任务线程 cards with a status chip.
  const lineClass = onUserBubble
    ? `${styles.assignmentLine} ${styles.assignmentOnUser}`
    : styles.assignmentLine;
  return (
    <>
      {batch && openTasks && (
        <button type="button" className={lineClass} onClick={openTasks}>
          <span className={styles.assignmentTitle}>
            {t("group.assignmentBatch", { count: batch.count, done: batch.done })}
          </span>
          <Chip tone={batch.done >= batch.count ? "ok" : "blue"}>
            {batch.done} / {batch.count}
          </Chip>
        </button>
      )}
      {collaborations?.map((item) => {
        const target = bots.find((bot) => bot.id === item.targetBotId);
        const color = target ? memberTone(botAvatarLook(target).color) : "blue";
        return (
          <button
            type="button"
            key={item.runId}
            className={lineClass}
            onClick={() => (item.threadId && openTask ? openTask(item.threadId) : openTasks?.())}
          >
            <span className={styles.assignmentTitle}>
              {t("group.collaborationThread", { target: target?.name ?? t("group.member") })}
            </span>
            <Chip
              tone={
                item.status === "done"
                  ? "ok"
                  : item.status === "error"
                    ? "danger"
                    : item.status === "aborted"
                      ? "warn"
                      : item.status === "queued"
                        ? "neutral"
                        : color
              }
            >
              {t(
                item.status === "done"
                  ? "group.taskState.done"
                  : item.status === "aborted"
                    ? "group.taskState.paused"
                    : item.status === "error"
                      ? "group.taskError"
                      : item.status === "queued"
                        ? "group.taskState.waiting"
                        : "group.taskState.running",
              )}
            </Chip>
            <span className={styles.assignmentOpen}>{t("group.viewThreadMore")}</span>
          </button>
        );
      })}
      {tasks
        ?.filter((task) => task.status === "open")
        .map((task) => (
          <RunApprovals
            key={task.id}
            botId={task.assigneeBotId}
            conversationId={task.threadConversationId}
            context={{
              botName: bots.find((bot) => bot.id === task.assigneeBotId)?.name ?? t("group.member"),
              groupName: groupName ?? "",
            }}
          />
        ))}
    </>
  );
}
