import { type MethodResults, PersonalTodoStickers } from "@pibot/protocol";
import {
  locateConversation,
  useAction,
  useNavigation,
  useRpc,
  useT,
  useWorkspace,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { PanelMenu } from "../profile/PanelMenu.tsx";
import styles from "./inbox.module.css";
import { PersonalTodoEditor } from "./PersonalTodoEditor.tsx";

type Todo = MethodResults["personalTodos.list"][number];

/** Calendar notes omit the inbox wrapper so the title has the full sidebar width. */
export function PersonalTodoNote({
  todo,
  close,
  refresh,
}: {
  todo: Todo;
  close(): void;
  refresh(): Promise<void>;
}) {
  const t = useT();
  const { peer } = useRpc();
  const data = useWorkspace();
  const { navigate } = useNavigation();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const origin = todo.origin;
  const name = origin?.botId
    ? (origin.botName ?? data.bots.find((bot) => bot.id === origin.botId)?.name)
    : undefined;
  const time =
    todo.dueAt && todo.dueAt.length > 10 ? todo.dueAt.slice(11, 16) : t("personalTodos.allDay");
  const openChat = () => {
    const conversationId = origin?.conversationId;
    if (!peer || !conversationId) return;
    void action.run(async (signal) => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let target: Awaited<ReturnType<typeof locateConversation>>;
      if (origin.groupId && origin.conversationKind === "group") {
        await peer.call(
          "groups.topics.switch",
          {
            groupId: origin.groupId,
            topicId: conversationId,
          },
          { signal: bounded, timeoutMs: 30_000 },
        );
        target = { name: "chat", groupId: origin.groupId };
      } else {
        target = await locateConversation(
          peer,
          conversationId,
          bounded,
          data.bots,
          data.groups,
          origin.botId ?? undefined,
        );
      }
      signal.throwIfAborted();
      close();
      navigate({
        ...target,
        ...(origin.messageId ? { focus: { messageId: origin.messageId } } : {}),
      });
    });
  };
  return (
    <article className={styles.todoNote} data-todo-color={todo.color ?? "apricot"}>
      <div className={styles.todoNoteHead}>
        <input
          type="checkbox"
          aria-label={t(todo.status === "open" ? "personalTodos.complete" : "personalTodos.reopen")}
          checked={todo.status === "done"}
          disabled={!peer || action.busy}
          onChange={() =>
            void action.run(async (signal) => {
              await peer?.call(
                "personalTodos.setStatus",
                {
                  id: todo.id,
                  status: todo.status === "open" ? "done" : "open",
                },
                { signal, timeoutMs: 15_000 },
              );
              await refresh();
            })
          }
        />
        <strong className={todo.status === "done" ? styles.doneTitle : undefined}>
          {todo.title}
        </strong>
        {todo.sticker && (
          <span
            className={styles.todoNoteSticker}
            role="img"
            aria-label={t(`personalTodos.sticker.${todo.sticker}`)}
          >
            {PersonalTodoStickers[todo.sticker]}
          </span>
        )}
        <PanelMenu
          label={t("personalTodos.actions")}
          disabled={!peer || action.busy}
          items={[
            { id: "edit", label: t("personalTodos.edit"), run: () => setEditing(true) },
            {
              id: "delete",
              label: t("personalTodos.delete"),
              danger: true,
              run: () => setDeleting(true),
            },
          ]}
        />
      </div>
      <div className={styles.todoNoteMeta}>
        {time}
        {name ? ` · ${t("personalTodos.from", { name })}` : ""}
      </div>
      {origin?.conversationId && (
        <Button
          variant="ghost"
          className={styles.todoNoteOpen}
          disabled={!peer || action.busy}
          onClick={openChat}
        >
          {t("workspace.inboxOpenChat")}
        </Button>
      )}
      {action.error && <p role="alert">{t(action.error)}</p>}
      {deleting && (
        <div role="alertdialog" aria-label={t("personalTodos.delete")} className={styles.confirm}>
          <p>{t("personalTodos.deleteConfirm")}</p>
          <Button variant="secondary" disabled={action.busy} onClick={() => setDeleting(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={action.busy}
            onClick={() =>
              void action.run(async (signal) => {
                await peer?.call(
                  "personalTodos.delete",
                  { id: todo.id, confirmed: true },
                  { signal, timeoutMs: 15_000 },
                );
                await refresh();
              })
            }
          >
            {t("personalTodos.delete")}
          </Button>
        </div>
      )}
      {editing && (
        <PersonalTodoEditor todo={todo} close={() => setEditing(false)} saved={refresh} />
      )}
    </article>
  );
}
