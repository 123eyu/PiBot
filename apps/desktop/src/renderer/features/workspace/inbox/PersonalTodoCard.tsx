import { type PersonalTodo, PersonalTodoStickers } from "@pibot/protocol";
import { useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { useState } from "react";
import styles from "./inbox.module.css";
import { PersonalTodoEditor } from "./PersonalTodoEditor.tsx";

import { dueIsPast, dueText } from "./personal-todo-calendar-date.ts";

export function PersonalTodoCard({
  todo,
  refresh,
  record,
  removed,
  calendar,
}: {
  todo: PersonalTodo;
  refresh(): Promise<void>;
  record(todo: PersonalTodo): void;
  removed?(): void;
  calendar?: boolean;
}) {
  const t = useT(),
    { peer } = useRpc(),
    action = useAction();
  const [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState(false);
  const toggle = () =>
    void action.run(async (signal) => {
      const next = await peer?.call(
        "personalTodos.setStatus",
        { id: todo.id, status: todo.status === "open" ? "done" : "open" },
        { signal, timeoutMs: 15000 },
      );
      if (next) record(next);
      await refresh();
    });
  return (
    <article
      className={styles.card}
      data-calendar-note={calendar || undefined}
      data-todo-color={todo.color ?? "apricot"}
    >
      <header className={styles.cardHeader}>
        {calendar && (
          <input
            type="checkbox"
            aria-label={t(
              todo.status === "open" ? "personalTodos.complete" : "personalTodos.reopen",
            )}
            checked={todo.status === "done"}
            disabled={!peer || action.busy}
            onChange={toggle}
          />
        )}
        <div className={styles.heading}>
          <strong className={todo.status === "done" ? styles.doneTitle : undefined}>
            <span className={styles.todoDot} aria-hidden="true" /> {todo.title}{" "}
            {todo.sticker ? PersonalTodoStickers[todo.sticker] : null}
          </strong>
          <div className={styles.source}>{t("personalTodos.note")}</div>
        </div>
        {todo.dueAt && (
          <Chip
            tone={todo.status === "open" && dueIsPast(todo.dueAt, todo.endAt) ? "danger" : "amber"}
          >
            {t("personalTodos.due", {
              date: todo.endAt ? `${dueText(todo.dueAt)} – ${todo.endAt}` : dueText(todo.dueAt),
            })}
          </Chip>
        )}
        {todo.status === "done" && <Chip tone="ok">{t("personalTodos.done")}</Chip>}
      </header>
      <div className={styles.links}>
        {action.error && <p role="alert">{t(action.error)}</p>}
        {!calendar && (
          <Button variant="pill" disabled={!peer} loading={action.busy} onClick={toggle}>
            {t(todo.status === "open" ? "personalTodos.complete" : "personalTodos.reopen")}
          </Button>
        )}
        <Button variant="pill" disabled={!peer || action.busy} onClick={() => setEditing(true)}>
          {t("personalTodos.edit")}
        </Button>
        <Button variant="ghost" disabled={!peer || action.busy} onClick={() => setDeleting(true)}>
          {t("personalTodos.delete")}
        </Button>
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
                    { signal, timeoutMs: 15000 },
                  );
                  removed?.();
                  await refresh();
                })
              }
            >
              {t("personalTodos.delete")}
            </Button>
          </div>
        )}
      </div>
      {editing && (
        <PersonalTodoEditor
          todo={todo}
          close={() => setEditing(false)}
          saved={async (next) => {
            record(next);
            await refresh();
          }}
        />
      )}
    </article>
  );
}
