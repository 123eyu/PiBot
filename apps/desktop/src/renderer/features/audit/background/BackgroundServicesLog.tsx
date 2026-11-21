import type { Bot } from "@pibot/protocol";
import { useSettings } from "@pibot/renderer-kit";
import { Button, IconTile, SegmentedControl } from "@pibot/ui";
import { useEffect, useState } from "react";
import { BackgroundServiceRow } from "./BackgroundServiceRow.tsx";
import styles from "./background.module.css";
import { useBackgroundServices } from "./use-background-services.ts";

/** Uptime is shown in minutes, so a coarse clock is enough. */
const TICK_MS = 30_000;

/**
 * Records · "Background services" tab. Same page and filters as the other Records tabs
 * (Bot and time filters apply within the retained 30-day history): what is running
 * now, then what stopped, who stopped it and why.
 */
export function BackgroundServicesLog({
  botId,
  bots,
  groupId,
  from,
  onVisibleCount,
}: {
  botId: string;
  bots: Map<string, Bot>;
  groupId?: string;
  from?: string;
  onVisibleCount?(count: number): void;
}) {
  const { t } = useSettings();
  const { running, ended, retry, more } = useBackgroundServices(botId, groupId, from);
  useEffect(() => {
    onVisibleCount?.(running.rows.length + ended.rows.length);
  }, [running.rows.length, ended.rows.length, onVisibleCount]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running.rows.length) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running.rows.length]);
  const [view, setView] = useState<"running" | "ended">("running");
  const count = (list: typeof running) =>
    list.rows.length ? ` · ${list.rows.length}${list.more ? "+" : ""}` : "";
  // Running and stopped are two views of one segmented control.
  const state = view;
  const list = view === "running" ? running : ended;
  return (
    <>
      <p className={styles.note}>{t("backgroundLog.note")}</p>
      <SegmentedControl
        className={styles.views}
        label={t("backgroundLog.views")}
        value={view}
        options={[
          { value: "running", label: `${t("backgroundLog.running")}${count(running)}` },
          { value: "ended", label: `${t("backgroundLog.ended")}${count(ended)}` },
        ]}
        onValueChange={setView}
      />
      <section
        aria-label={t(state === "running" ? "backgroundLog.running" : "backgroundLog.ended")}
        aria-busy={list.loading || undefined}
      >
        {list.rows.length > 0 && (
          <div className={styles.card}>
            {list.rows.map((row) => (
              <BackgroundServiceRow key={row.id} row={row} bot={bots.get(row.botId)} now={now} />
            ))}
          </div>
        )}
        {list.loading && (
          <p role="status" className={styles.note}>
            {t("common.loading")}
          </p>
        )}
        {list.error && (
          <p role="alert" className={styles.error}>
            {t("backgroundLog.error")}{" "}
            <Button variant="pill" disabled={list.loading} onClick={() => retry(state)}>
              {t("common.retry")}
            </Button>
          </p>
        )}
        {!list.rows.length && !list.loading && !list.error && (
          <div className={styles.empty}>
            <IconTile icon={state === "running" ? "server" : "archive"} tone="teal" size="lg" />
            <span>
              {t(state === "running" ? "backgroundLog.runningEmpty" : "backgroundLog.endedEmpty")}
            </span>
          </div>
        )}
        {list.more && !list.error && (
          <Button
            variant="pill"
            className={styles.more}
            disabled={list.loading}
            onClick={() => more(state)}
          >
            {t("activity.more")}
          </Button>
        )}
      </section>
    </>
  );
}
