import { inboxGroupCount, inboxTotal } from "@pibot/client-core";
import { useNavigation, useT } from "@pibot/renderer-kit";
import { Button, CloseButton, IconTile, PageHeading, pageTone } from "@pibot/ui";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useMemoryTargets } from "../memory/use-memory-targets.ts";
import { InboxCard } from "./InboxCard.tsx";
import styles from "./inbox.module.css";
import { PersonalTodoList } from "./PersonalTodoList.tsx";
import { type InboxKind, useInbox } from "./use-inbox.ts";

const kinds = [undefined, "confirmation", "action", "routines"] as const;
const views = ["pending", "personal_todo"] as const;
function kindLabel(value: InboxKind | undefined) {
  return value === "confirmation"
    ? "workspace.inboxConfirmation"
    : value === "action"
      ? "workspace.inboxActionRequired"
      : value === "routines"
        ? "workspace.inboxRoutines"
        : "workspace.inboxAll";
}

/** A row of tabs with arrow / Home / End keys; the segmented and chip strips share it. */
function TabStrip<T extends string | undefined>({
  label,
  className,
  tabClassName,
  values,
  selected,
  firstRef,
  select,
  render,
}: {
  label: string;
  className?: string;
  tabClassName?: string;
  values: readonly T[];
  selected: T;
  firstRef?: RefObject<HTMLButtonElement | null>;
  select(value: T): void;
  render(value: T): string;
}) {
  const index = Math.max(0, values.indexOf(selected));
  return (
    <div
      role="tablist"
      aria-label={label}
      className={className}
      style={{ "--seg-count": values.length, "--seg-index": index } as CSSProperties}
    >
      {values.map((value, position) => (
        <button
          key={value ?? "all"}
          ref={position === 0 ? firstRef : undefined}
          type="button"
          role="tab"
          aria-selected={value === selected}
          tabIndex={value === selected ? 0 : -1}
          className={tabClassName}
          onClick={() => select(value)}
          onKeyDown={(event) => {
            const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? values.length - 1
                  : direction
                    ? (position + direction + values.length) % values.length
                    : undefined;
            if (next === undefined) return;
            event.preventDefault();
            select(values[next] as T);
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>("button")
              [next]?.focus();
          }}
        >
          {render(value)}
        </button>
      ))}
    </div>
  );
}
export function Inbox({ close }: { close(): void }) {
  const t = useT();
  const { view } = useNavigation();
  const [kind, setKind] = useState<InboxKind>();
  const allTab = useRef<HTMLButtonElement>(null);
  const list = useInbox(kind);
  const memoryTargets = useMemoryTargets(list.items, list.revision);
  const refresh = useCallback(async () => list.reload(), [list.reload]);
  const total = inboxTotal(list.counts);
  const count = (value: InboxKind | undefined) =>
    value ? inboxGroupCount(value, list.counts) : total;
  // A removed category must not leave the page on a hidden selected tab.
  const emptySelection =
    kind !== undefined &&
    kind !== "personal_todo" &&
    count(kind) === 0 &&
    !list.loading &&
    !list.error;
  useEffect(() => {
    if (emptySelection) {
      setKind(undefined);
      allTab.current?.focus();
    }
  }, [emptySelection]);
  const pendingKinds = kinds.filter((value) => value === undefined || count(value) > 0);
  // Switching to personal to-dos and back returns to the category the person had chosen.
  const lastPending = useRef<InboxKind>(undefined);
  if (kind !== "personal_todo") lastPending.current = kind;
  const pending = count(kind);
  return (
    <main className={styles.main} style={pageTone("amber")}>
      <header className={styles.header}>
        <div className={styles.title}>
          <PageHeading icon="inbox" tone="amber">
            {t("workspace.inbox")}
          </PageHeading>
          <span className={styles.note}>{t("workspace.inboxNote")}</span>
        </div>
        <TabStrip
          label={t("workspace.inboxView")}
          className={styles.segments}
          tabClassName={styles.segment}
          values={views}
          selected={kind === "personal_todo" ? "personal_todo" : "pending"}
          select={(value) =>
            setKind(value === "personal_todo" ? "personal_todo" : lastPending.current)
          }
          render={(value) =>
            value === "personal_todo"
              ? `${t("personalTodos.tab")} ${count("personal_todo")}`
              : t("workspace.inboxPending")
          }
        />
        {view.name !== "inbox" && <CloseButton label={t("workspace.close")} onClick={close} />}
      </header>
      {kind !== "personal_todo" && (
        <div className={styles.filters}>
          <TabStrip<InboxKind | undefined>
            label={t("workspace.inboxKinds")}
            className={styles.chips}
            tabClassName={styles.chip}
            values={pendingKinds}
            selected={kind}
            firstRef={allTab}
            select={setKind}
            render={(value) => `${t(kindLabel(value))} ${count(value)}`}
          />
        </div>
      )}
      <div className={styles.scroll}>
        <div
          className={styles.cards}
          data-personal-todo={kind === "personal_todo" || undefined}
          role="tabpanel"
          aria-label={t("workspace.inbox")}
        >
          {kind === "personal_todo" ? (
            <PersonalTodoList close={close} />
          ) : (
            <>
              {list.loading && (
                <p className={styles.status} role="status">
                  {t("common.loading")}
                </p>
              )}
              {list.error && (
                <p className={styles.banner} role="alert">
                  {t("workspace.unavailable")}{" "}
                  <Button variant="pill" onClick={list.reload}>
                    {t("common.retry")}
                  </Button>
                </p>
              )}
              {!list.loading && !list.error && pending === 0 && (
                <div className={styles.empty} role="status">
                  <IconTile icon="check" tone="green" size="lg" className={styles.emptyMark} />
                  <strong>{t(kind ? "workspace.inboxDone" : "workspace.inboxEmpty")}</strong>
                  <span className={styles.emptyNote}>{t("workspace.inboxEmptyNote")}</span>
                </div>
              )}
              {list.items.map((item) => (
                <InboxCard
                  key={item.cursor}
                  item={item}
                  close={close}
                  refresh={refresh}
                  record={list.record}
                  forget={list.forget}
                  memories={
                    item.kind === "memory"
                      ? memoryTargets?.get(item.proposal.botId)?.memories
                      : undefined
                  }
                  memoriesLoading={
                    item.kind === "memory" &&
                    (!memoryTargets || !!memoryTargets.get(item.proposal.botId)?.loading)
                  }
                />
              ))}
              {list.more && (
                <Button variant="pill" loading={list.loading} onClick={() => void list.loadMore()}>
                  {t("workspace.more")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
