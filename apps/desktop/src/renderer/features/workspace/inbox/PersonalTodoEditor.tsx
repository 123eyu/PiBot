import { localDeadline } from "@pibot/client-core";
import { type PersonalTodo, PersonalTodoColors, PersonalTodoStickers } from "@pibot/protocol";
import { DateField, Overlay, useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import styles from "./inbox.module.css";

export function PersonalTodoEditor({
  todo,
  initialDate,
  close,
  saved,
}: {
  todo?: PersonalTodo;
  initialDate?: string;
  close(): void;
  saved(todo: PersonalTodo): Promise<void>;
}) {
  const t = useT(),
    { peer } = useRpc(),
    action = useAction();
  const [title, setTitle] = useState(todo?.title ?? "");
  const [date, setDate] = useState(todo?.dueAt?.slice(0, 10) ?? initialDate ?? "");
  const [time, setTime] = useState(todo?.dueAt?.slice(11, 16) ?? "");
  const [endAt, setEndAt] = useState(todo?.endAt ?? "");
  const [color, setColor] = useState(todo?.color ?? "apricot");
  const [sticker, setSticker] = useState<PersonalTodo["sticker"]>(todo?.sticker ?? null);
  const invalidEnd = !!endAt && (!date || endAt < date);
  const [requestId] = useState(() => crypto.randomUUID());
  const uncertain = action.error === "workspace.createUncertain";
  return (
    <Overlay
      icon={todo ? "edit" : "plus"}
      tone="amber"
      title={t(todo ? "personalTodos.edit" : "personalTodos.new")}
      close={close}
      busy={action.busy}
    >
      <form
        className={styles.editor}
        onSubmit={(event) => {
          event.preventDefault();
          if (!peer || !title.trim() || invalidEnd || uncertain) return;
          void action.run(async (signal) => {
            // Editing only the title must not erase an existing deadline's time and offset.
            const dueAt =
              todo &&
              date === todo.dueAt?.slice(0, 10) &&
              time === (todo.dueAt?.slice(11, 16) ?? "")
                ? todo.dueAt
                : date && time
                  ? localDeadline(date, time)
                  : date || null;
            const input = { title: title.trim(), dueAt, color, sticker, endAt: endAt || null };
            const next = todo
              ? await peer.call(
                  "personalTodos.update",
                  { id: todo.id, ...input },
                  { signal, timeoutMs: 15000 },
                )
              : await peer.call(
                  "personalTodos.create",
                  { requestId, ...input },
                  { signal, timeoutMs: 15000 },
                );
            await saved(next);
            close();
          });
        }}
      >
        <label>
          {t("personalTodos.title")}
          <input
            required
            maxLength={500}
            value={title}
            disabled={action.busy || uncertain}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
        </label>
        <label>
          {t("personalTodos.date")}
          <DateField
            label={t("personalTodos.date")}
            tone="amber"
            value={date}
            disabled={action.busy || uncertain}
            onValueChange={setDate}
          />
        </label>
        <label>
          {t("personalTodos.time")}
          {/* The app's own picker in time mode, not the browser's native AM/PM spinner. */}
          <DateField
            mode="time"
            label={t("personalTodos.time")}
            tone="amber"
            value={time}
            clearable
            disabled={!date || action.busy || uncertain}
            onValueChange={setTime}
          />
        </label>
        <label>
          {t("personalTodos.end")}
          <DateField
            label={t("personalTodos.end")}
            tone="amber"
            value={endAt}
            disabled={action.busy || uncertain}
            onValueChange={setEndAt}
          />
        </label>
        {invalidEnd && <p role="alert">{t("personalTodos.invalidEnd")}</p>}
        <fieldset className={styles.todoFieldset} disabled={action.busy || uncertain}>
          <legend>{t("personalTodos.color")}</legend>
          <div className={styles.todoChoices}>
            {PersonalTodoColors.map((key) => (
              <button
                type="button"
                key={key}
                className={styles.todoSwatch}
                data-todo-color={key}
                aria-label={t(`personalTodos.color.${key}`)}
                aria-pressed={color === key}
                onClick={() => setColor(key)}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className={styles.todoFieldset} disabled={action.busy || uncertain}>
          <legend>{t("personalTodos.sticker")}</legend>
          <div className={styles.todoChoices}>
            <Button
              type="button"
              variant="pill"
              aria-pressed={!sticker}
              onClick={() => setSticker(null)}
            >
              {t("personalTodos.none")}
            </Button>
            {Object.entries(PersonalTodoStickers).map(([key, emoji]) => (
              <Button
                type="button"
                variant="pill"
                key={key}
                aria-label={t(`personalTodos.sticker.${key as keyof typeof PersonalTodoStickers}`)}
                aria-pressed={sticker === key}
                onClick={() => setSticker(key as keyof typeof PersonalTodoStickers)}
              >
                {emoji}
              </Button>
            ))}
          </div>
        </fieldset>
        {action.error && <p role="alert">{t(action.error)}</p>}
        <div className={styles.links}>
          <Button
            type="submit"
            disabled={!peer || !title.trim() || invalidEnd || uncertain}
            loading={action.busy}
          >
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Overlay>
  );
}
