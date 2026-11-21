import { isIndefinitePause } from "@pibot/protocol";
import { type Peer, useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button, IconTile, PageHeading, pageTone } from "@pibot/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRoutineBots } from "../editor/use-routine-bot.ts";
import { routineTime } from "../format-time.ts";
import { useRoutineNavigation } from "../shell/navigation.ts";
import { useRoutinePower, useRoutinesPorts } from "../shell/ports.tsx";
import { useRemote, useRoutineAction, useRoutineRefresh } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { Timeline } from "../timeline/Timeline.tsx";
import { systemTimezone } from "../triggers/cron.ts";
import { usePages } from "./paging.ts";
import { RoutineItem } from "./RoutineItem.tsx";
import { useRoutineRows } from "./rows.ts";

export function RoutinesPage() {
  const { peer } = useRpc();
  const power = useRoutinePower();
  const exitBehavior = useRoutinesPorts().useExitBehavior();
  const { t, language } = useSettings();
  const { openRoutines, routineRevision } = useRoutineNavigation();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
      else
        document
          .querySelector<HTMLElement>("[data-routines-trigger]")
          ?.focus({ preventScroll: true });
    };
  }, []);
  const [awayOnly, setAwayOnly] = useState(false);
  const load = useCallback(
    (peer: Peer, before?: string) => peer.call("routines.list", { before, limit: 50 }),
    [],
  );
  const page = usePages(load);
  const visible = page.rows.filter((routine) => !awayOnly || routine.pausedReason === "away_7d");
  const states = useRoutineRows(visible);
  const bots = useRoutineBots(visible.map((routine) => routine.botId));
  const loadSummary = useCallback((peer: Peer) => peer.call("routines.summary", undefined), []);
  const summary = useRemote(loadSummary);
  const refresh = useCallback(() => {
    page.refresh();
    summary.refresh();
  }, [page.refresh, summary.refresh]);
  useRoutineRefresh(refresh);
  const lastRevision = useRef(routineRevision);
  useEffect(() => {
    if (lastRevision.current === routineRevision) return;
    lastRevision.current = routineRevision;
    refresh();
  }, [routineRevision, refresh]);
  const action = useRoutineAction();
  useRpcEvent("power.state", summary.refresh);
  useEffect(() => {
    const timer = setInterval(summary.refresh, 30_000);
    return () => clearInterval(timer);
  }, [summary.refresh]);
  return (
    <main className={styles.page} style={pageTone("orange")}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitle}>
          <PageHeading icon="clock" tone="orange" ref={heading} tabIndex={-1}>
            {t("routines.title")}
          </PageHeading>
          <p className={styles.note}>
            {summary.value
              ? t("routines.count", {
                  count: summary.value.counts.enabled,
                  timezone: systemTimezone(),
                })
              : t(summary.error ?? "common.loading")}
          </p>
        </div>
        <Button className={styles.toneButton} disabled={!peer} onClick={() => openRoutines("new")}>
          {t("routines.new")}
        </Button>
        {summary.error && (
          <Button variant="secondary" onClick={summary.refresh}>
            {t("common.retry")}
          </Button>
        )}
      </header>
      <div className={styles.pageScroll}>
        <div className={`${styles.pageContent} ${styles.stack}`}>
          {summary.value && (
            <>
              <div className={styles.serviceCard} role="status">
                <IconTile icon="power" tone="green" />
                <div className={styles.grow}>
                  <strong>
                    {t("routines.background")} ·{" "}
                    {t(`computer.state.${summary.value.background.state}`)}
                  </strong>
                  <p className={styles.note}>
                    {t("routines.liveCounts", {
                      running: summary.value.counts.running,
                      waiting: summary.value.counts.waiting,
                      queued: summary.value.counts.scheduled,
                    })}
                  </p>
                  <p className={styles.note}>
                    {power ? (
                      <>
                        {t(`routines.power.${power.state}`)} · {t(`routines.power.${power.supply}`)}{" "}
                        · {t(`routines.blocker.${power.keepAwake}`)}
                      </>
                    ) : (
                      t("computer.powerUnknown")
                    )}
                  </p>
                </div>
              </div>
              {summary.value.pausedUntil && (
                <div className={styles.banner} data-tone="warn">
                  <IconTile icon="pause" tone="amber" size="sm" />
                  <span className={styles.grow}>
                    {isIndefinitePause(summary.value.pausedUntil)
                      ? t("routines.pausedIndefinitely")
                      : t("routines.pausedUntil", {
                          time: routineTime(summary.value.pausedUntil, language),
                        })}
                  </span>
                  <Button
                    className={styles.toneButton}
                    disabled={action.disabled}
                    onClick={() => {
                      if (peer)
                        void action
                          .run(() => peer.call("routines.resumeAll", undefined))
                          .then((r) => {
                            if (r) refresh();
                          });
                    }}
                  >
                    {t("routines.resumeAll")}
                  </Button>
                </div>
              )}
              {summary.value.counts.awayPaused > 0 && (
                <div className={styles.banner} data-tone="warn">
                  <IconTile icon="moon" tone="amber" size="sm" />
                  <span className={styles.grow}>
                    {t("routines.away", { count: summary.value.counts.awayPaused })}
                  </span>
                  <Button
                    variant="pill"
                    aria-pressed={awayOnly}
                    onClick={() => setAwayOnly((v) => !v)}
                  >
                    {t("routines.reviewAway")}
                  </Button>
                  <Button
                    className={styles.toneButton}
                    disabled={action.disabled}
                    onClick={() => {
                      if (peer)
                        void action
                          .run(() => peer.call("routines.resumeAway", {}))
                          .then((r) => {
                            if (r) refresh();
                          });
                    }}
                  >
                    {t("routines.resume")}
                  </Button>
                </div>
              )}
            </>
          )}
          <Timeline />
          {!!visible.length && (
            <h2 className={styles.section}>{t("routines.tasks", { count: visible.length })}</h2>
          )}
          <div className={styles.list}>
            {visible.map((routine) => (
              <RoutineItem
                key={routine.id}
                routine={routine}
                bot={bots.get(routine.botId)}
                state={states.value?.rows.get(routine.id)}
                pausedUntil={states.value?.pausedUntil}
                asOf={states.value?.at}
                open={() => openRoutines(routine.id)}
              />
            ))}
          </div>
          {states.loading && !!visible.length && <p role="status">{t("common.loading")}</p>}
          {states.error && (
            <p role="alert" className={styles.error}>
              {t(states.error)} <Button onClick={states.refresh}>{t("common.retry")}</Button>
            </p>
          )}
          {page.loading && <p role="status">{t("common.loading")}</p>}
          {!page.loading && !page.error && !page.rows.length && (
            <div className={styles.empty}>
              <IconTile icon="clock" tone="orange" size="lg" className={styles.emptyMark} />
              <strong className={styles.emptyTitle}>{t("routines.emptyTitle")}</strong>
              <p className={styles.note}>{t("routines.emptyNote")}</p>
            </div>
          )}
          {(page.error || action.error) && (
            <p role="alert" className={styles.error}>
              {t(page.error ?? action.error ?? "routines.failed")}{" "}
              <Button onClick={refresh}>{t("common.retry")}</Button>
            </p>
          )}
          {page.more && (
            <Button variant="secondary" disabled={page.loading} onClick={() => void page.next()}>
              {t("routines.more")}
            </Button>
          )}
          <p className={styles.note}>
            {t(
              exitBehavior === "continue"
                ? "routines.footerContinue"
                : exitBehavior === "stop"
                  ? "routines.footerStop"
                  : "routines.footer",
            )}
          </p>
        </div>
      </div>
    </main>
  );
}
