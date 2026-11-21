import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask, Message } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import { TaskHistoryMessage } from "../../execution/TaskHistoryMessage.tsx";
import styles from "../group.module.css";

export function GroupTaskHistory({ peer, task }: { peer: ChatPeer; task: GroupTask }) {
  const t = useT(),
    [limit, setLimit] = useState(25),
    [revision, refresh] = useState(0);
  const [value, setValue] = useState<{
    messages: Message[];
    more: boolean;
    error: boolean;
    busy: boolean;
  }>({ messages: [], more: false, error: false, busy: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: paging and retry extend the retained read-only history window.
  useEffect(() => {
    const controller = new AbortController();
    setValue((old) => ({ ...old, busy: true, error: false }));
    void (async () => {
      const messages: Message[] = [];
      let before: string | undefined,
        more = false;
      for (let count = 0; count < limit; count += 25) {
        const page = await peer.call(
          "groups.tasks.history",
          { groupId: task.groupId, taskId: task.id, before, limit: 25 },
          { signal: controller.signal, timeoutMs: 10000 },
        );
        messages.unshift(...page.messages);
        more = !!page.nextBefore;
        if (!page.nextBefore) break;
        if (before === page.nextBefore) throw new Error("group_task_history_stalled");
        before = page.nextBefore;
      }
      if (!controller.signal.aborted) setValue({ messages, more, busy: false, error: false });
    })().catch(() => {
      if (!controller.signal.aborted) setValue((old) => ({ ...old, busy: false, error: true }));
    });
    return () => controller.abort();
  }, [peer, task.id, task.groupId, limit, revision]);
  return (
    <div className={styles.taskHistoryRecords}>
      {value.error && (
        <p role="alert" className={styles.error}>
          {t("chat.historyError")}{" "}
          <Button variant="ghost" onClick={() => refresh((v) => v + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {value.busy && <p role="status">{t("common.loading")}</p>}
      {value.more && limit < 100 && (
        <Button variant="ghost" disabled={value.busy} onClick={() => setLimit((v) => v + 25)}>
          {t("chat.loadEarlier")}
        </Button>
      )}
      {!value.busy && !value.messages.length && (
        <p className={styles.note}>{t("execution.noHistory")}</p>
      )}
      {value.messages.map((message) => (
        <TaskHistoryMessage
          key={message.id}
          message={message}
          botId={message.botId ?? task.assigneeBotId}
          timeline
        />
      ))}
    </div>
  );
}
