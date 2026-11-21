import { type Peer, useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePages } from "../page/paging.ts";
import { plannedTarget } from "../shell/locate.ts";
import { useRoutineAction, useRoutineRefresh } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { systemTimezone } from "../triggers/cron.ts";
import { RunRow } from "./RunHistory.tsx";
import { TimelineTrack } from "./TimelineTrack.tsx";
import { powerIntervals, usePlanned, usePower } from "./timeline-data.ts";
import { timelinePointLabel, timelinePoints } from "./timeline-points.ts";
import { useTimelineMetadata } from "./use-timeline-metadata.ts";

export function Timeline() {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const { navigate, closeSettings } = useNavigation();
  const action = useRoutineAction();
  const [now, setNow] = useState(() => new Date());
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  const timezone = systemTimezone();
  const planned = usePlanned(date, timezone);
  const power = usePower(date, timezone);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
      planned.refresh();
    }, 60_000);
    return () => clearInterval(timer);
  }, [planned.refresh]);
  const loadRuns = useCallback(
    async (peer: Peer, before?: string) => {
      const page = await peer.call("routines.timeline", {
        date,
        timezone,
        source: "runs",
        before,
        limit: 50,
      });
      if (page.source !== "runs") throw new Error("Timeline source mismatch");
      return page.runs;
    },
    [date, timezone],
  );
  const runs = usePages(loadRuns);
  const refresh = useCallback(() => {
    setNow(new Date());
    power.refresh();
    runs.refresh();
    planned.refresh();
  }, [power.refresh, runs.refresh, planned.refresh]);
  useRoutineRefresh(refresh, undefined, { power: true });
  const [selected, setSelected] = useState<{ id: string; peer: Peer | null; scope: string }>();
  const scope = `${date}/${timezone}`;
  const window = planned.batch?.meta;
  const from = window?.from;
  const to = window?.to;
  const position = useCallback(
    (at: string | Date) =>
      from && to
        ? Math.max(
            0,
            Math.min(
              100,
              ((new Date(at).getTime() - new Date(from).getTime()) /
                (new Date(to).getTime() - new Date(from).getTime())) *
                100,
            ),
          )
        : 0,
    [from, to],
  );
  const points = useMemo(
    () => timelinePoints(runs.rows, planned.batch?.items ?? [], position),
    [runs.rows, planned.batch, position],
  );
  const metadata = useTimelineMetadata(points, scope);
  const describe = (point: (typeof points)[number]) =>
    timelinePointLabel(point, metadata, t, language);
  const chooseRun = (id: string) => setSelected({ id, peer, scope });
  const until = to && new Date(to) < now ? to : now.toISOString();
  const complete = power.batch && !power.more && !power.error;
  // Newest-first pages can omit state transitions; paint certainty only after the source is complete.
  const segments =
    from && complete && power.batch
      ? powerIntervals(power.batch.meta, power.batch.items, from, until)
      : from
        ? [{ from, to: until, state: "unknown" as const }]
        : [];
  const current =
    selected?.peer === peer && selected.scope === scope
      ? runs.rows.find((r) => r.id === selected.id)
      : undefined;
  return (
    <section className={styles.card}>
      <h2>
        {t("routines.today")} · {date} · {timezone}
      </h2>
      <div className={styles.timeline}>
        <TimelineTrack
          points={window ? points : []}
          describe={describe}
          disabled={action.disabled}
          from={from}
          to={to}
          select={(point) => {
            if (point.run) chooseRun(point.run.id);
            else if (peer && point.planned) {
              const target = point.planned;
              void action
                .run((signal) => plannedTarget(peer, target, signal))
                .then((view) => {
                  if (view) {
                    closeSettings();
                    navigate(view);
                  }
                });
            }
          }}
        >
          {segments.map((s) => (
            <span
              key={s.from}
              className={s.state === "suspended" ? styles.sleep : styles.unknown}
              data-power={s.state}
              title={t(s.state === "suspended" ? "routines.sleep" : "routines.powerUncertain")}
              style={{
                left: `${position(s.from)}%`,
                width: `${position(s.to) - position(s.from)}%`,
              }}
            />
          ))}
          <span className={styles.now} style={{ left: `${position(now)}%` }} />
        </TimelineTrack>
        <div className={styles.ticks}>
          {[0, 6, 12, 18, 24].map((hour) => {
            const at = new Date(from ?? start);
            at.setHours(hour);
            return (
              <span key={hour} style={{ left: `${position(at)}%` }}>
                {String(hour).padStart(2, "0")}:00
              </span>
            );
          })}
        </div>
      </div>
      <p className={styles.note}>{t("routines.timelineNote")}</p>
      {(!complete || segments.some((s) => s.state === "unknown")) && (
        <p className={styles.note}>
          {t(power.more ? "routines.powerIncomplete" : "routines.powerUncertain")}
        </p>
      )}
      {planned.more && <p className={styles.note}>{t("routines.plannedMore")}</p>}
      {!planned.loading && !planned.error && !planned.batch?.items.length && (
        <p className={styles.note}>{t("routines.noPlan")}</p>
      )}
      {metadata.unavailable && (
        <p className={styles.note} role="status">
          {t("routines.timelineMetadataUnavailable")}{" "}
          <Button variant="secondary" onClick={metadata.refresh}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
      {current && <RunRow run={current} />}
      {(power.loading || runs.loading || planned.loading) && (
        <p role="status">{t("common.loading")}</p>
      )}
      {(power.error || runs.error || planned.error) && (
        <p role="alert" className={styles.error}>
          {t(power.error ?? runs.error ?? planned.error ?? "routines.failed")}{" "}
          <Button onClick={refresh}>{t("common.retry")}</Button>
        </p>
      )}
      <div className={styles.row}>
        {planned.more && (
          <Button
            variant="secondary"
            disabled={planned.loading}
            onClick={() => void planned.next()}
          >
            {t("routines.morePlanned")}
          </Button>
        )}
        {power.more && (
          <Button variant="secondary" disabled={power.loading} onClick={() => void power.next()}>
            {t("routines.morePower")}
          </Button>
        )}
        {runs.more && (
          <Button variant="secondary" disabled={runs.loading} onClick={() => void runs.next()}>
            {t("routines.more")}
          </Button>
        )}
      </div>
    </section>
  );
}
