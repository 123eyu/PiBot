import { displayTopicTitle } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import { botPanelStyles as styles, useSettings } from "@pibot/renderer-kit";
import { Button, Icon, IconTile, SegmentedControl, type Tone } from "@pibot/ui";
import { type ReactNode, useEffect, useRef } from "react";
export interface TopicRow {
  id: string;
  title?: string;
  updatedAt: string;
  messageCount?: number;
}
export type TopicRunState = "running" | "queued" | "waiting";
const runStateLabel = {
  running: "agentWork.running",
  queued: "agentWork.queued",
  waiting: "agentWork.waiting",
} as const satisfies Record<TopicRunState, TranslationKey>;
/** Each topic leads with a chat tile; its colour repeats the run state at a glance. */
const runStateTone = {
  running: "blue",
  queued: "neutral",
  waiting: "amber",
} as const satisfies Record<TopicRunState, Tone>;
const topicTone = (archived: boolean, state?: TopicRunState): Tone =>
  archived ? "neutral" : state ? runStateTone[state] : "teal";

/** DM and group topics share their list, filtering, row actions, typography and icons. */
export function TopicListView<T extends TopicRow>({
  topics,
  currentId,
  archived,
  setArchived,
  query,
  setQuery,
  loading,
  error,
  retry,
  editing,
  title,
  setTitle,
  rename,
  startRename,
  displayTitle,
  canRename,
  cancelRename,
  busy,
  restoring,
  available,
  open,
  restore,
  folderName,
  status,
  extra,
  more,
  loadMore,
}: {
  topics: T[];
  currentId?: string;
  archived: boolean;
  setArchived(value: boolean): void;
  query: string;
  setQuery(value: string): void;
  loading: boolean;
  error?: TranslationKey;
  retry(): void;
  editing?: string;
  title: string;
  setTitle(value: string): void;
  rename(id: string): void;
  startRename(topic: T): void;
  /** Title as shown (a scheduled task's topic is named after the task). */
  displayTitle?(topic: T): string;
  /** Topics whose title follows something else (a task's name) are not renamed here. */
  canRename?(topic: T): boolean;
  cancelRename(): void;
  busy: boolean;
  restoring: boolean;
  available: boolean;
  open(topic: T): void;
  restore(id: string): void;
  folderName(topic: T): string;
  /** Shown as an icon after the title (maintainers 2026-11-05: an icon, no text); the label is its tooltip. */
  status?(topic: T): TopicRunState | undefined;
  extra?(topic: T): ReactNode;
  more: boolean;
  loadMore(): void;
}) {
  const { t, language } = useSettings(),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const groups = new Map<"today" | "week" | "earlier", T[]>([
    ["today", []],
    ["week", []],
    ["earlier", []],
  ]);
  for (const topic of topics) {
    const date = new Date(topic.updatedAt);
    groups.get(date >= today ? "today" : date >= week ? "week" : "earlier")?.push(topic);
  }
  return (
    <div className={styles.stack}>
      <SegmentedControl
        label={t("workspace.topics")}
        value={archived ? "archived" : "active"}
        options={[
          { value: "active", label: t("topic.active") },
          { value: "archived", label: t("topic.archived") },
        ]}
        onValueChange={(value) => {
          cancelRename();
          setArchived(value === "archived");
        }}
      />
      {archived && <p className={styles.note}>{t("topic.archivedHint")}</p>}
      <div className={styles.search}>
        <Icon name="search" size={14} />
        <input
          type="search"
          aria-label={t("workspace.topicSearch")}
          placeholder={t("workspace.topicSearch")}
          maxLength={200}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      {loading && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}{" "}
          <Button variant="pill" onClick={retry}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      <div className={styles.topicGroups}>
        {[...groups].map(
          ([period, items]) =>
            items.length > 0 && (
              <section key={period}>
                <div className={styles.groupTitle}>{t(`workspace.topicGroup.${period}`)}</div>
                <div className={styles.topicCard}>
                  {items.map((topic) => (
                    <div key={topic.id}>
                      <div className={styles.topic} data-current={topic.id === currentId}>
                        <IconTile
                          icon={archived ? "archive" : "message"}
                          tone={topicTone(archived, status?.(topic))}
                          className={styles.topicMark}
                        />
                        {editing === topic.id ? (
                          <input
                            ref={input}
                            className={styles.renameInput}
                            aria-label={t("workspace.rename")}
                            value={title}
                            maxLength={200}
                            disabled={busy}
                            onChange={(event) => setTitle(event.currentTarget.value)}
                            onBlur={() => rename(topic.id)}
                            onKeyDown={(event) => {
                              if (
                                event.nativeEvent.isComposing ||
                                event.nativeEvent.keyCode === 229
                              )
                                return;
                              if (event.key === "Enter") {
                                event.preventDefault();
                                rename(topic.id);
                              }
                              if (event.key === "Escape") {
                                event.stopPropagation();
                                cancelRename();
                              }
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className={styles.topicButton}
                            aria-current={topic.id === currentId || undefined}
                            disabled={busy || restoring || !available || archived}
                            onClick={() => open(topic)}
                          >
                            <span className={styles.topicTitleRow}>
                              <span className={styles.topicTitle}>
                                {displayTopicTitle(
                                  displayTitle?.(topic) ?? (topic.title || t("workspace.untitled")),
                                  t("messages.forwardedTitle"),
                                )}
                              </span>
                              <TopicRunMark state={status?.(topic)} />
                            </span>
                            {extra?.(topic)}
                            <span className={styles.topicMeta}>{folderName(topic)}</span>
                            <span className={styles.topicMeta}>
                              <time dateTime={topic.updatedAt}>
                                {new Date(topic.updatedAt).toLocaleString(
                                  language,
                                  period === "today"
                                    ? { hour: "2-digit", minute: "2-digit", hour12: false }
                                    : period === "week"
                                      ? {
                                          weekday: "short",
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          hour12: false,
                                        }
                                      : { month: "short", day: "numeric" },
                                )}
                              </time>{" "}
                              · {t("workspace.topicMessages", { count: topic.messageCount ?? 0 })}
                            </span>
                          </button>
                        )}
                        {topic.id === currentId && (
                          <span className={styles.current}>{t("workspace.currentTopic")}</span>
                        )}
                        {archived ? (
                          <Button
                            variant="pill"
                            disabled={busy || restoring || !available}
                            onClick={() => restore(topic.id)}
                          >
                            {t("topic.restore")}
                          </Button>
                        ) : canRename?.(topic) === false ? null : (
                          <Button
                            variant="circle"
                            className={styles.rename}
                            aria-label={t("workspace.renameTopic", {
                              title: topic.title || t("workspace.untitled"),
                            })}
                            disabled={busy}
                            onClick={() => startRename(topic)}
                          >
                            <Icon name="edit" size={14} />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ),
        )}
      </div>
      {!loading && !error && !topics.length && (
        <p className={styles.note}>{t("workspace.empty")}</p>
      )}
      {more && (
        <Button
          variant="pill"
          className={styles.more}
          disabled={busy || loading}
          onClick={loadMore}
        >
          {t("workspace.moreTopics")}
        </Button>
      )}
    </div>
  );
}

function TopicRunMark({ state }: { state?: TopicRunState }) {
  const { t } = useSettings();
  if (!state) return null;
  const text = t(runStateLabel[state]);
  return (
    <span
      className={styles.topicRunMark}
      data-state={state}
      role="img"
      aria-label={text}
      title={text}
    >
      {state === "running" ? (
        <span className={styles.topicRunSpinner} />
      ) : (
        <Icon name={state === "queued" ? "clock" : "hand"} size={13} />
      )}
    </span>
  );
}
