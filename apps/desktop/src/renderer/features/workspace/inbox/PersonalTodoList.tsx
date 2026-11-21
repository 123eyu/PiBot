import type { MethodResults, PersonalTodo } from "@pibot/protocol";
import { useAction, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { InboxOriginCard } from "./InboxOriginCard.tsx";
import styles from "./inbox.module.css";
import { PersonalTodoCalendar } from "./PersonalTodoCalendar.tsx";
import { PersonalTodoCard } from "./PersonalTodoCard.tsx";
import { PersonalTodoEditor } from "./PersonalTodoEditor.tsx";
import { dayKey } from "./personal-todo-calendar-date.ts";

type Status = PersonalTodo["status"];
type Rows = MethodResults["personalTodos.list"];
/** Position in the open-then-completed sequence; null once every selected status is exhausted. */
type Cursor = { index: number; before?: string } | null;
const STATUS_ORDER: readonly Status[] = ["open", "done"];
const PAGE = 30;

/** One "more" page across the selected statuses: open items first, then completed ones. */
async function todoPage(
  peer: NonNullable<ReturnType<typeof useRpc>["peer"]>,
  statuses: readonly Status[],
  from: NonNullable<Cursor>,
  signal: AbortSignal,
): Promise<{ rows: Rows; next: Cursor }> {
  const rows: Rows = [];
  let { index, before } = from;
  for (;;) {
    const status = statuses[index] as Status;
    const next = await peer.call(
      "personalTodos.list",
      { status, before, limit: PAGE },
      { signal, timeoutMs: 15000 },
    );
    rows.push(...next);
    if (next.length === PAGE) return { rows, next: { index, before: next.at(-1)?.id } };
    index++;
    before = undefined;
    if (index >= statuses.length) return { rows, next: null };
    if (rows.length >= PAGE) return { rows, next: { index } };
  }
}

/** Completed items remain manageable after restarting; Inbox receipts are not the source of truth. */
export function PersonalTodoList({ close }: { close(): void }) {
  const { t, settings, update } = useSettings(),
    { peer } = useRpc(),
    action = useAction();
  const view = settings?.personalTodoView ?? "list";
  const viewAction = useAction();
  const [selected, select] = useState(() => dayKey(new Date()));
  // Maintainers 2026-11-16: Open / Completed are filters shared by both views; both on by default.
  const saved = settings?.personalTodoStatuses;
  const statuses = useMemo(
    () => STATUS_ORDER.filter((status) => (saved ?? STATUS_ORDER).includes(status)),
    [saved],
  );
  const statusKey = statuses.join(",");
  const [rows, setRows] = useState<Rows>([]),
    [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false),
    [cursor, setCursor] = useState<Cursor>(null);
  const [counts, setCounts] = useState<MethodResults["personalTodos.counts"]>();
  const [revision, refresh] = useState(0);
  const query = useMemo(
    () => ({ peer, statusKey, revision, view }),
    [peer, statusKey, revision, view],
  );
  const currentQuery = useRef(query);
  currentQuery.current = query;
  useEffect(() => peer?.on("inbox.changed", () => refresh((n) => n + 1)), [peer]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads the totals after any change.
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    void peer
      .call("personalTodos.counts", undefined, { signal: abort.signal, timeoutMs: 15000 })
      .then(
        (next) => {
          if (!abort.signal.aborted) setCounts(next);
        },
        // The chips still work without numbers; the list shows its own load error.
        () => {},
      );
    return () => abort.abort();
  }, [peer, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: inbox 事件和操作完成递增 revision，主动重取同一查询。
  useEffect(() => {
    const abort = new AbortController();
    setRows([]);
    setLoading(true);
    setFailed(false);
    setCursor(null);
    if (view !== "list") return;
    if (!peer) {
      setLoading(false);
      setFailed(true);
      return;
    }
    void todoPage(peer, statuses, { index: 0 }, abort.signal)
      .then(
        (page) => {
          if (!abort.signal.aborted) {
            setRows(page.rows);
            setCursor(page.next);
          }
        },
        () => {
          if (!abort.signal.aborted) setFailed(true);
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [peer, statusKey, revision, view]);
  const reload = async () => {
    refresh((n) => n + 1);
  };
  const created = async () => {
    // Both create entrances must reveal the new open item, even in a completed-only view.
    if (!statuses.includes("open"))
      await viewAction.run(() => update({ personalTodoStatuses: [...statuses, "open"] }));
    await reload();
  };
  const toggle = (status: Status) => {
    const next = statuses.includes(status)
      ? statuses.filter((item) => item !== status)
      : [...statuses, status];
    // At least one stays on: clearing the last one falls back to Open.
    void viewAction.run(() => update({ personalTodoStatuses: next.length ? next : ["open"] }));
  };
  const firstDone = statuses.length > 1 ? rows.findIndex((todo) => todo.status === "done") : -1;
  return (
    <>
      <div className={styles.todoBar}>
        <div className={styles.todoFilter}>
          <span className={styles.todoFilterLabel}>{t("personalTodos.show")}</span>
          {STATUS_ORDER.map((status) => (
            <Button
              key={status}
              variant="pill"
              aria-pressed={statuses.includes(status)}
              disabled={!settings || viewAction.busy}
              onClick={() => toggle(status)}
            >
              <span className={styles.todoFilterCheck} aria-hidden="true">
                {statuses.includes(status) && <Icon name="check" size={10} />}
              </span>
              {t(`personalTodos.${status}`)}
              {counts && <span className={styles.todoFilterCount}>{counts[status]}</span>}
            </Button>
          ))}
        </div>
        {/* Same segmented control as Open / Completed, not swatch pills. */}
        <div className={styles.todoStatus} data-done={view === "calendar" || undefined}>
          {(["list", "calendar"] as const).map((option) => (
            <Button
              key={option}
              variant="pill"
              aria-pressed={view === option}
              disabled={!settings || viewAction.busy}
              onClick={() => {
                void viewAction.run(() => update({ personalTodoView: option }));
              }}
            >
              {t(`personalTodos.${option}`)}
            </Button>
          ))}
        </div>
        <Button disabled={!peer} className={styles.toneButton} onClick={() => setCreating(true)}>
          {t("personalTodos.new")}
        </Button>
      </div>
      {viewAction.error && <p role="alert">{t(viewAction.error)}</p>}
      {view === "calendar" ? (
        <PersonalTodoCalendar
          close={close}
          statuses={statuses}
          selected={selected}
          select={select}
          created={created}
        />
      ) : (
        <>
          {loading && (
            <p className={styles.status} role="status">
              {t("common.loading")}
            </p>
          )}
          {(failed || action.error) && (
            <p className={styles.banner} role="alert">
              {t("workspace.failed")}{" "}
              <Button variant="ghost" onClick={() => void reload()}>
                {t("common.retry")}
              </Button>
            </p>
          )}
          {!loading && !failed && !rows.length && (
            <div className={styles.empty}>
              <IconTile icon="check" tone="amber" size="lg" className={styles.emptyMark} />
              <strong>{t("personalTodos.empty")}</strong>
            </div>
          )}
          {rows.map((todo, index) => (
            <Fragment key={todo.id}>
              {index === firstDone && (
                <p className={styles.todoSection}>
                  {counts
                    ? t("personalTodos.doneSection", { count: counts.done })
                    : t("personalTodos.done")}
                </p>
              )}
              <InboxOriginCard
                close={close}
                item={{
                  kind: "personal_todo",
                  todo,
                  origin: todo.origin,
                  cursor: `${todo.createdAt}|personal_todo|${todo.id}`,
                }}
              >
                <PersonalTodoCard
                  todo={todo}
                  refresh={reload}
                  record={() => {}}
                  removed={() => setRows((old) => old.filter((item) => item.id !== todo.id))}
                />
              </InboxOriginCard>
            </Fragment>
          ))}
          {cursor && (
            <Button
              loading={action.busy}
              onClick={() =>
                void action.run(async (signal) => {
                  // A status switch, inbox refresh or reconnect invalidates this page, even if the
                  // transport has already delivered its response and cannot cancel it anymore.
                  if (!peer) return;
                  let page: Awaited<ReturnType<typeof todoPage>>;
                  try {
                    page = await todoPage(peer, statuses, cursor, signal);
                  } catch (error) {
                    if (currentQuery.current !== query) return;
                    throw error;
                  }
                  if (currentQuery.current === query && !signal.aborted) {
                    setRows((old) => [...old, ...page.rows]);
                    setCursor(page.next);
                  }
                })
              }
            >
              {t("workspace.more")}
            </Button>
          )}
        </>
      )}
      {creating && (
        <PersonalTodoEditor
          initialDate={view === "calendar" ? selected : undefined}
          close={() => setCreating(false)}
          saved={created}
        />
      )}
    </>
  );
}
