import type { GroupTask } from "@pibot/protocol";
import { useNavigation, useT } from "@pibot/renderer-kit";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";

export function TaskSource({ task, data }: { task: GroupTask; data: GroupSnapshot }) {
  const t = useT();
  const { navigate } = useNavigation();
  const source = task.source;
  if (!source?.available || source.kind === "unknown" || !source.messageId || !source.createdAt)
    return <span className={styles.taskSource}>{t("group.sourceMissing")}</span>;
  const time = new Date(source.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const name =
    data.bots.find((bot) => bot.id === task.createdByBotId)?.name ?? t("group.coordinator");
  return (
    <button
      type="button"
      className={styles.taskSource}
      onClick={() =>
        navigate({
          name: "chat",
          groupId: task.groupId,
          threadId:
            source.conversationId === data.group?.conversationId
              ? undefined
              : (source.conversationId ?? undefined),
          focus: { messageId: source.messageId as string },
        })
      }
    >
      {t(source.kind === "user" ? "group.sourceUser" : "group.sourceCoordinator", { time, name })} ↗
    </button>
  );
}
