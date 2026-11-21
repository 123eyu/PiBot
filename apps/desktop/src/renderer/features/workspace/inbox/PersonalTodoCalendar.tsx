import { todoOnDay as onDay, weekLanes } from "@pibot/client-core";
import { type MethodResults, PersonalTodoStickers } from "@pibot/protocol";
import { useRpc, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "./inbox.module.css";
import { PersonalTodoEditor } from "./PersonalTodoEditor.tsx";
import { PersonalTodoNote } from "./PersonalTodoNote.tsx";
import { dayDate, dayKey, dueIsPast, shiftDay } from "./personal-todo-calendar-date.ts";

type Todos = MethodResults["personalTodos.list"];
type Todo = Todos[number];

function overdue(todo: Todo) {
  return todo.status === "open" && !!todo.dueAt && dueIsPast(todo.dueAt, todo.endAt);
}

export function PersonalTodoCalendar({
  close,
  statuses,
  selected,
  select,
  created,
}: {
  close(): void;
  /** The list's Open / Completed filter, shared with the calendar. */
  statuses: readonly Todo["status"][];
  selected: string;
  select(day: string): void;
  created(): Promise<void>;
}) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const [creating, setCreating] = useState(false);
  const [revision, refresh] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    peer: typeof peer;
    rows: Todos;
    undated: number;
  }>();
  const [failed, setFailed] = useState<string>();
  const today = dayKey(new Date());
  const month = selected.slice(0, 7);
  const first = dayDate(`${month}-01`);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12);
  const gridStart = shiftDay(first, -first.getDay());
  const days = Array.from(
    { length: 7 * Math.ceil((first.getDay() + last.getDate()) / 7) },
    (_, i) => shiftDay(gridStart, i),
  );
  const upcomingEnd = dayKey(shiftDay(dayDate(selected), 7));
  const from = dayKey(gridStart);
  const gridEnd = dayKey(days.at(-1) ?? last);
  const to = gridEnd > upcomingEnd ? gridEnd : upcomingEnd;
  const key = `${from}:${to}:${revision}`;
  useEffect(() => peer?.on("inbox.changed", () => refresh((n) => n + 1)), [peer]);
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    const options = { signal: abort.signal, timeoutMs: 15_000 };
    const page = async (status: Todo["status"]) => {
      const rows: Todos = [];
      let before: string | undefined;
      for (;;) {
        abort.signal.throwIfAborted();
        const next: Todos = await peer.call(
          "personalTodos.list",
          { status, from, to, before, limit: 100 },
          options,
        );
        rows.push(...next);
        if (next.length < 100) return rows;
        const last = next.at(-1)?.id;
        if (!last || last === before) throw new Error("personal_todo_cursor_stalled");
        before = last;
      }
    };
    void Promise.all([
      page("open"),
      page("done"),
      peer.call("personalTodos.undatedCount", undefined, options),
    ]).then(
      ([open, done, undated]) => {
        if (!abort.signal.aborted) setResult({ key, peer, rows: [...open, ...done], undated });
      },
      () => {
        if (!abort.signal.aborted) {
          setFailed(key);
          abort.abort();
        }
      },
    );
    return () => abort.abort();
  }, [peer, from, to, key]);
  const data = result?.key === key && result.peer === peer ? result : undefined;
  const rows = data?.rows ?? [];
  // Both statuses can be on (shared filter); open ones claim the two lanes first.
  const visible = rows
    .filter((todo) => statuses.includes(todo.status))
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
  const ordered = [...visible].sort((a, b) => Number(!!b.endAt) - Number(!!a.endAt));
  const placements = days.flatMap((_, index) =>
    index % 7 === 0 ? weekLanes(days.slice(index, index + 7).map(dayKey), ordered) : [],
  );
  const monthly = rows.filter(
    (todo) =>
      todo.status === "open" &&
      todo.dueAt &&
      todo.dueAt.slice(0, 10) <= dayKey(last) &&
      (todo.endAt ?? todo.dueAt.slice(0, 10)) >= dayKey(first),
  );
  const monthlyDone = rows.filter(
    (todo) =>
      todo.status === "done" &&
      todo.dueAt &&
      todo.dueAt.slice(0, 10) <= dayKey(last) &&
      (todo.endAt ?? todo.dueAt.slice(0, 10)) >= dayKey(first),
  ).length;
  const upcoming = rows
    .filter((todo) => {
      const start = todo.dueAt?.slice(0, 10);
      return todo.status === "open" && start && start > selected && start <= upcomingEnd;
    })
    .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  const label = new Intl.DateTimeFormat(language, { dateStyle: "full" });
  const weekday = new Intl.DateTimeFormat(language, { weekday: "short" });
  const nextMonth = (delta: number) =>
    select(dayKey(new Date(first.getFullYear(), first.getMonth() + delta, 1, 12)));
  return (
    <div className={styles.todoCalendar}>
      <section className={styles.todoMonth}>
        <div className={styles.todoMonthHead}>
          <h2>
            {new Intl.DateTimeFormat(language, { month: "long", year: "numeric" }).format(first)}
          </h2>
          <div className={styles.todoChoices}>
            <Button
              variant="pill"
              aria-label={t("personalTodos.previous")}
              onClick={() => nextMonth(-1)}
            >
              ‹
            </Button>
            <Button
              variant="pill"
              aria-label={t("personalTodos.next")}
              onClick={() => nextMonth(1)}
            >
              ›
            </Button>
            <Button variant="pill" onClick={() => select(today)}>
              {t("personalTodos.today")}
            </Button>
          </div>
        </div>
        {data && (
          <p className={styles.source}>
            {t("personalTodos.monthStats", {
              open: monthly.length,
              late: monthly.filter(overdue).length,
            })}
            {statuses.includes("done") &&
              ` · ${t("personalTodos.monthDone", { count: monthlyDone })}`}
          </p>
        )}
        {!peer || failed === key ? (
          <p role="alert">
            {t("workspace.failed")}{" "}
            <Button variant="ghost" onClick={() => refresh((n) => n + 1)}>
              {t("common.retry")}
            </Button>
          </p>
        ) : (
          !data && <p role="status">{t("common.loading")}</p>
        )}
        <div className={styles.todoGrid}>
          {days.slice(0, 7).map((day) => (
            <span className={styles.todoWeekday} data-weekday={day.getDay()} key={dayKey(day)}>
              {weekday.format(day)}
            </span>
          ))}
          {days.map((day, index) => {
            const date = dayKey(day);
            const placement = placements[index];
            const lanes = placement?.lanes ?? [];
            const overflow = (placement?.count ?? 0) - lanes.filter(Boolean).length;
            const sticker = lanes.find(
              (todo) => todo?.sticker && todo.dueAt?.slice(0, 10) === date,
            )?.sticker;
            return (
              <button
                type="button"
                key={date}
                className={styles.todoDay}
                data-weekday={day.getDay()}
                data-out={!date.startsWith(month) || undefined}
                aria-pressed={date === selected}
                aria-label={label.format(day)}
                onClick={() => select(date)}
              >
                <span className={styles.todoDayNumber} data-today={date === today || undefined}>
                  {day.getDate()}
                </span>
                {sticker && (
                  <span className={styles.todoDaySticker}>{PersonalTodoStickers[sticker]}</span>
                )}
                {lanes.map((todo, lane) => {
                  if (!todo)
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the two empty lanes are fixed positions, not items.
                      <span key={`empty-${lane}`} className={styles.todoLane} aria-hidden="true" />
                    );
                  const start = todo.dueAt?.slice(0, 10);
                  const joinsLeft = day.getDay() !== 0 && !!start && date > start;
                  const joinsRight = day.getDay() !== 6 && !!todo.endAt && date < todo.endAt;
                  return (
                    <span
                      key={todo.id}
                      className={styles.todoLabel}
                      data-todo-color={todo.color ?? "apricot"}
                      data-left={joinsLeft || undefined}
                      data-right={joinsRight || undefined}
                      data-late={overdue(todo) || undefined}
                      data-done={todo.status === "done" || undefined}
                      title={todo.title}
                    >
                      {joinsLeft ? "\u00a0" : todo.title}
                    </span>
                  );
                })}
                {overflow > 0 && <span className={styles.todoMore}>+{overflow}</span>}
              </button>
            );
          })}
        </div>
      </section>
      <section className={styles.todoDayPanel}>
        <h3>{label.format(dayDate(selected))}</h3>
        {data && !visible.some((todo) => onDay(todo, selected)) && (
          <p className={styles.source}>{t("personalTodos.emptyDay")}</p>
        )}
        {visible
          .filter((todo) => onDay(todo, selected))
          .map((todo) => (
            <PersonalTodoNote
              key={todo.id}
              todo={todo}
              close={close}
              refresh={async () => refresh((n) => n + 1)}
            />
          ))}
        <Button
          variant="ghost"
          className={styles.todoDayAdd}
          disabled={!peer}
          onClick={() => setCreating(true)}
        >
          {t("personalTodos.newDay")}
        </Button>
        <h4 className={styles.todoUpcomingTitle}>{t("personalTodos.upcoming")}</h4>
        {upcoming.map((todo) => (
          <div
            className={styles.todoUpcoming}
            key={todo.id}
            data-todo-color={todo.color ?? "apricot"}
          >
            <time>{todo.dueAt?.slice(0, 10)}</time> <span className={styles.todoDot} />{" "}
            <span className={styles.todoUpcomingText}>{todo.title}</span>
          </div>
        ))}
        {data && (
          <p className={styles.source}>{t("personalTodos.undated", { count: data.undated })}</p>
        )}
      </section>
      {creating && (
        <PersonalTodoEditor
          initialDate={selected}
          close={() => setCreating(false)}
          saved={async () => {
            refresh((n) => n + 1);
            await created();
          }}
        />
      )}
    </div>
  );
}
