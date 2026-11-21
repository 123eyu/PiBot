import type { ChatPeer } from "@pibot/client-core";
import type { GroupRunState } from "./conversation/run-state.ts";
import type { GroupSnapshot, ReadKind } from "./data.ts";

// The controller owns disposal; only group-scoped events invalidate their own read lane.
export function subscribeGroupData(
  peer: ChatPeer,
  groupId: string,
  {
    getSnapshot,
    publish,
    changed,
  }: {
    getSnapshot(): GroupSnapshot;
    publish(patch: Partial<GroupSnapshot>, defer?: boolean): void;
    /** identity: the group itself may differ (created / deleted / members), not a routine update. */
    changed(kind: ReadKind, identity?: boolean): void;
  },
  runState: GroupRunState,
) {
  const ended = (
    e: Parameters<GroupRunState["terminal"]>[1],
    status?: "done" | "error" | "aborted",
  ) => {
    publish({ runs: runState.terminal(getSnapshot().runs, e, status) }, true);
    changed("runs");
    changed("cycle");
    changed("tasks");
  };
  return [
    peer.on("chat.message", (event) => {
      if (
        getSnapshot().runs.some(
          (run) => run.id === event.runId && run.botId === event.botId && run.groupId === groupId,
        )
      )
        changed("runs");
    }),
    peer.on("groups.changed", (e) => {
      if (e.groupId === groupId) changed("group", e.reason !== "updated");
    }),
    peer.on("group.paused", (e) => {
      if (e.groupId === groupId) changed("group");
    }),
    peer.on("bots.changed", (e) => {
      if (getSnapshot().group?.members.some((member) => member.botId === e.botId))
        changed("members");
    }),
    peer.on("permissions.changed", (e) => {
      if ((!e.botId && !e.groupId) || e.groupId === groupId) changed("group");
    }),
    peer.on("group.task", (e) => {
      if (e.task.groupId !== groupId) return;
      publish({
        tasks: getSnapshot().tasks.map((task) =>
          task.id === e.task.id && !(task.status !== "open" && e.task.status === "open")
            ? e.task
            : task,
        ),
      });
      changed("tasks");
      changed("cycle");
    }),
    peer.on("execution.task.changed", (task) => {
      const data = getSnapshot();
      if (
        (task.conversationId === data.group?.conversationId &&
          data.group.members.some((member) => member.botId === task.botId)) ||
        data.tasks.some(
          (assignment) =>
            assignment.threadConversationId === task.conversationId &&
            assignment.assigneeBotId === task.botId,
        )
      )
        changed("tasks");
    }),
    peer.on("chat.status", (e) => {
      if (e.groupId !== groupId || !e.runId) return;
      if (e.state === "idle") ended(e);
      else {
        publish(
          {
            runs: runState.progress(
              getSnapshot().runs,
              e,
              e.state === "running" ? "running" : "queued",
            ),
          },
          true,
        );
        changed("runs");
        changed("cycle");
        changed("tasks");
      }
    }),
    peer.on("chat.done", (e) => {
      if (e.groupId === groupId) ended(e, "done");
    }),
    peer.on("chat.error", (e) => {
      if (e.groupId === groupId) ended(e, e.code === "aborted" ? "aborted" : "error");
    }),
  ];
}
