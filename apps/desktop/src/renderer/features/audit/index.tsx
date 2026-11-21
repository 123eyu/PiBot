import {
  type AuditFilter,
  type AuditRange,
  auditCutoff,
  auditDays,
  auditGroup,
  auditResult,
  auditSummary,
  collapseRepeats,
  isSystemAudit,
  safeAuditText,
} from "@pibot/client-core";
import { ComputerStepsLog } from "@pibot/computer-use/ui";
import type { AuditEntry } from "@pibot/protocol";
import { AppSelect, useNavigation, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { Button, IconTile, PageHeading, pageTone, Switch } from "@pibot/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityRow } from "./ActivityRow.tsx";
import type { ActivityEntry } from "./activity.ts";
import styles from "./audit.module.css";
import { BackgroundServicesLog } from "./background/BackgroundServicesLog.tsx";
import { activityMark } from "./marks.ts";
import { commandKey } from "./pager.ts";
import {
  activityTypes,
  isActivityType,
  readActivityType,
  saveActivityType,
} from "./type-filter.ts";
import { useAuditBots } from "./use-bots.ts";
import { useActivityCounts } from "./use-counts.ts";
import { useActivityRecords } from "./use-records.ts";

/**
 * Rows that look the same fold: same kind tile, visible summary, Bot and visible outcome, like the
 * phone's records. Raw fields used to decide (maintainers 2026-11-16): each phone action wrote a
 * "started" and an "allowed" record that both read "Updated", and to-do changes differed only by
 * the hidden target id, so thousands of identical rows never folded. Expanding still lists every
 * record. Routine runs carry their own status and never fold.
 */
function repeatKey(
  entry: ActivityEntry,
  t: Parameters<typeof auditResult>[1],
  sources: Map<string, AuditEntry>,
) {
  if (entry.type !== "audit") return undefined;
  const record = entry.entry;
  // Replay refusals are intentionally the same user-facing fact even when different
  // tools caused the burst. Keep the reason separate so "already done" and "unknown" never fold.
  if (record.kind === "tool.journal.replay_blocked")
    return JSON.stringify([record.kind, record.botId, record.detail.reasonCode ?? null]);
  const result = auditResult(record, t);
  const todoAction =
    record.kind === "personal_todo.changed" ? (record.detail.reasonCode ?? null) : null;
  return JSON.stringify([
    auditGroup(record),
    auditSummary(record, t, { source: sources.get(commandKey(record)) }),
    record.botId,
    isSystemAudit(record),
    result.text,
    result.tone,
    todoAction,
  ]);
}
export function AuditLog({
  initialBotId = "",
  groupId,
}: {
  initialBotId?: string;
  groupId?: string;
}) {
  const { t, language } = useSettings();
  const { settingsOverlay } = useNavigation();
  const workspace = useWorkspace();
  const directory = useAuditBots();
  const [botId, setBotId] = useState(initialBotId);
  const [range, setRange] = useState<AuditRange>("7");
  const [type, setType] = useState(readActivityType);
  const sourceTab = type === "computer" || type === "background" ? type : undefined;
  const filter: AuditFilter = sourceTab ? "all" : (type as AuditFilter);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sourceCount, setSourceCount] = useState({ scope: "", count: 0 });
  const choose = (value: string) => {
    if (!isActivityType(value)) return;
    setType(value);
    saveActivityType(value);
    setOpen(undefined);
  };
  const [showInternal, setShowInternal] = useState(false);
  const [open, setOpen] = useState<string>();
  // Consecutive identical records (e.g. a burst of the same phone action) fold into one ×N row.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const toggleUnfolded = (id: string) =>
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useActivityRecords(
    botId,
    filter,
    range,
    showInternal,
    50,
    !groupId,
    groupId,
    !sourceTab,
  );
  const counts = useActivityCounts(botId, groupId, range, showInternal, list.day);
  const from = auditCutoff(range, new Date(list.day));
  const sourceScope = JSON.stringify([sourceTab, botId, groupId, from, refreshKey]);
  const visibleSourceCount = useCallback(
    (count: number) => setSourceCount({ scope: sourceScope, count }),
    [sourceScope],
  );
  const refresh = () => {
    counts.refresh();
    setRefreshKey((value) => value + 1);
    void list.refresh();
  };
  const bots = useMemo(
    () => new Map([...directory.bots, ...workspace.bots].map((bot) => [bot.id, bot])),
    [workspace.bots, directory.bots],
  );
  useLayoutEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
      else
        document.querySelector<HTMLElement>("[data-audit-trigger]")?.focus({ preventScroll: true });
    };
  }, []);
  const settingsOpen = useRef(false);
  useEffect(() => {
    if (settingsOpen.current && !settingsOverlay) {
      void list.refresh();
      counts.refresh();
    }
    settingsOpen.current = !!settingsOverlay;
  }, [settingsOverlay, list.refresh, counts.refresh]);
  const observedNames = new Map(
    list.entries.flatMap((entry) =>
      entry.type === "routine-run" && entry.run.bot
        ? [[entry.botId, entry.run.bot.name] as const]
        : [],
    ),
  );
  const botOptions = [
    { value: "", label: t("audit.allBots") },
    ...[...bots.values()].map((bot) => ({
      value: bot.id,
      label: `${bot.name}${bot.archivedAt ? ` · ${t("activity.archived")}` : ""}`,
    })),
    ...[...new Set([...list.entries.map((entry) => entry.botId), ...(botId ? [botId] : [])])]
      .filter((id) => !bots.has(id))
      .map((id) => ({ value: id, label: safeAuditText(observedNames.get(id) ?? id, 200) })),
    ...(directory.more
      ? [{ value: "more", label: t("activity.moreBots"), disabled: directory.loading }]
      : []),
  ];
  return (
    <main className={styles.main} style={pageTone("teal")}>
      <header className={styles.header}>
        <div>
          <PageHeading icon="audit" tone="teal" ref={heading} tabIndex={-1}>
            {t("audit.title")}
          </PageHeading>
          <span className={styles.lead}>
            {t(groupId ? "activity.groupScope" : "activity.note")}
          </span>
        </div>
      </header>
      <div className={styles.filters}>
        <div className={styles.tabs}>
          <AppSelect
            label={t("audit.bot")}
            hideLabel
            variant="pill"
            value={botId}
            options={botOptions}
            change={(value) => {
              if (value === "more") void directory.load();
              else {
                setBotId(value);
                setOpen(undefined);
              }
            }}
          />
          <AppSelect
            label={t("activity.time")}
            hideLabel
            variant="pill"
            value={range}
            options={(["7", "30", "90", "all"] as const).map((value) => ({
              value,
              label: t(`activity.range.${value}`),
            }))}
            change={(value) => {
              setRange(value as AuditRange);
              setOpen(undefined);
            }}
          />
          <AppSelect
            label={t("audit.kind")}
            searchPlaceholder={t("combobox.searchCategories")}
            hideLabel
            variant="pill"
            value={type}
            options={activityTypes.map((value) => {
              const label = t(value === "all" ? "audit.allTypes" : `activity.kind.${value}`);
              const count = counts.counts?.[value];
              const mark = activityMark(value);
              return {
                value,
                label: `${label} · ${count ?? "…"}`,
                muted: count === 0,
                // Each type keeps the colour its rows use.
                leading: <IconTile icon={mark.icon} tone={mark.tone} size="sm" />,
              };
            })}
            change={choose}
          />
        </div>
        <div className={styles.detailStatus}>
          <div className={styles.internalFilter}>
            <span>{t("audit.showInternal")}</span>
            <Switch
              label={t("audit.showInternal")}
              checked={showInternal}
              disabled={!!sourceTab}
              onCheckedChange={(value) => {
                setShowInternal(value);
                setOpen(undefined);
              }}
            />
          </div>
          <span className={styles.note} aria-live="polite">
            {t("audit.visibleCount", {
              count: sourceTab
                ? sourceCount.scope === sourceScope
                  ? sourceCount.count
                  : 0
                : list.entries.length,
            })}
          </span>
          <Button variant="pill" disabled={!sourceTab && list.loading} onClick={refresh}>
            {t("activity.refresh")}
          </Button>
        </div>
      </div>
      <div className={styles.scroll}>
        <div className={styles.content}>
          {counts.error && (
            <p className={styles.danger} role="alert">
              {t("audit.countsError")}
            </p>
          )}
          {sourceTab === "computer" ? (
            <ComputerStepsLog
              key={`${groupId ?? "all"}:${botId}:${from}:${refreshKey}`}
              groupId={groupId}
              from={from}
              onVisibleCount={visibleSourceCount}
              botId={botId}
              botName={(id) => bots.get(id)?.name ?? observedNames.get(id)}
            />
          ) : sourceTab === "background" ? (
            <BackgroundServicesLog
              key={`${groupId ?? "all"}:${botId}:${from}:${refreshKey}`}
              botId={botId}
              groupId={groupId}
              from={from}
              onVisibleCount={visibleSourceCount}
              bots={bots}
            />
          ) : (
            <>
              {directory.error && (
                <p className={styles.danger} role="alert">
                  {t("audit.botsError")}{" "}
                  <Button
                    variant="pill"
                    disabled={directory.loading}
                    onClick={() => void directory.load()}
                  >
                    {t("common.retry")}
                  </Button>
                </p>
              )}
              {directory.loading && (
                <span className={styles.note} role="status">
                  {t("activity.loadingBots")}
                </span>
              )}
              {list.error && (
                <p className={styles.danger} role="alert">
                  {t("audit.error")}{" "}
                  <Button variant="pill" disabled={list.loading} onClick={() => void list.load()}>
                    {t("common.retry")}
                  </Button>
                </p>
              )}
              {auditDays(list.entries, language, t).map(([day, group]) => (
                <section key={day} aria-label={group.label} className={styles.day}>
                  <h2>{group.label}</h2>
                  <div className={styles.dayCard}>
                    {collapseRepeats(
                      group.entries,
                      (entry) => entry.id,
                      (entry) => repeatKey(entry, t, list.sources),
                    ).map((repeat) => {
                      const row = (entry: (typeof repeat.rows)[number]) => (
                        <ActivityRow
                          key={entry.id}
                          entry={entry}
                          bot={bots.get(entry.botId)}
                          sources={list.sources}
                          expanded={open === entry.id}
                          toggle={() => setOpen(open === entry.id ? undefined : entry.id)}
                        />
                      );
                      const [first, ...rest] = repeat.rows;
                      if (!first || !rest.length) return first ? row(first) : null;
                      const shown = unfolded.has(repeat.id);
                      return (
                        <div key={repeat.id} className={styles.repeat}>
                          {row(first)}
                          <Button
                            variant="pill"
                            className={styles.repeatToggle}
                            aria-expanded={shown}
                            onClick={() => toggleUnfolded(repeat.id)}
                          >
                            {t(shown ? "activity.repeatHide" : "activity.repeatShow", {
                              count: repeat.rows.length,
                            })}
                          </Button>
                          {shown && <div className={styles.repeatRows}>{rest.map(row)}</div>}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
              {list.loading && (
                <p role="status" className={styles.note}>
                  {t("common.loading")}
                </p>
              )}
              {!list.entries.length && !list.loading && !list.error && (
                <div className={styles.empty}>
                  <IconTile icon="audit" tone="teal" size="lg" className={styles.emptyMark} />
                  <p>{t(list.more ? "activity.scanMore" : "activity.empty")}</p>
                </div>
              )}
              {list.more && (
                <Button
                  variant="pill"
                  className={styles.more}
                  disabled={list.loading}
                  onClick={() => void list.load()}
                >
                  {t("activity.more")}
                </Button>
              )}
              <p className={styles.footer}>{t("activity.footer")}</p>
              <p className={styles.retention}>
                {t(
                  filter === "all" || filter === "scheduling"
                    ? "activity.routineRetention"
                    : "activity.retention",
                )}
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
