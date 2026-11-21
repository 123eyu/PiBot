import { safeAuditText } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import type { BackgroundCommandRecord, Bot } from "@pibot/protocol";
import { useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, Chip, IconTile, StatusDot } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { BackgroundPortButtons } from "../../execution/BackgroundPortButtons.tsx";
import { requestBrowserPane } from "../../side-pane/browser-requests.ts";
import styles from "./background.module.css";

type T = ReturnType<typeof useSettings>["t"];

export function duration(ms: number, t: T) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t("backgroundLog.duration.short");
  if (minutes < 60) return t("backgroundLog.duration.minutes", { minutes });
  return t("backgroundLog.duration.hours", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

function placeLabel(row: BackgroundCommandRecord, t: T) {
  const place = row.place;
  if (!place) return t("backgroundLog.place.gone");
  const title = safeAuditText(place.title, 200) || t("backgroundLog.place.untitled");
  if (place.kind === "thread")
    return t("backgroundLog.place.thread", {
      group: safeAuditText(place.groupName ?? "", 200) || t("backgroundLog.place.untitled"),
      title,
    });
  return t(place.kind === "group" ? "backgroundLog.place.group" : "backgroundLog.place.topic", {
    title,
  });
}

/** Who ended it and why: you, the Bot (by name) or Pi Bot itself. */
function ending(row: BackgroundCommandRecord, botName: string, t: T) {
  if (row.status === "exited")
    return {
      by: undefined,
      reason: t("backgroundLog.reason.exited", { code: row.exitCode ?? "?" }),
    };
  if (row.status === "failed") return { by: undefined, reason: t("backgroundLog.reason.failed") };
  const reason = row.stopReason ?? "user";
  return {
    by:
      reason === "user"
        ? t("backgroundLog.by.user")
        : reason === "bot"
          ? botName
          : t("backgroundLog.by.system"),
    reason: t(`backgroundLog.reason.${reason}` as TranslationKey),
  };
}

/**
 * One background command in Records: Bot, command (shortened, full text on hover), ports,
 * times and the chat it belongs to; running ones can be stopped or opened in the system browser
 * through the same brain RPCs as the chat line.
 */
export function BackgroundServiceRow({
  row,
  bot,
  now,
}: {
  row: BackgroundCommandRecord;
  bot?: Bot;
  now: number;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const { navigate } = useNavigation();
  const [busy, setBusy] = useState<"stop" | number>();
  const [error, setError] = useState<TranslationKey>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const name = bot?.name ?? t("audit.actor.deletedBot");
  const running = row.status === "running";
  const started = new Date(row.startedAt);
  const ended = row.endedAt ? new Date(row.endedAt) : undefined;
  const clock = (date: Date) =>
    date.toLocaleString(language, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const act = async (action: "stop" | number) => {
    if (!peer || busy !== undefined) return;
    setBusy(action);
    setError(undefined);
    try {
      if (action === "stop")
        await peer.call("backgroundCommands.stop", { botId: row.botId, id: row.id });
      else {
        // Opens in the Bot's own browser; show it beside the chat the service belongs to.
        await peer.call("backgroundCommands.open", { botId: row.botId, id: row.id, port: action });
        requestBrowserPane(row.botId, row.groupId ?? undefined);
        if (mounted.current) go(true);
      }
    } catch {
      if (mounted.current) setError("background.actionError");
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };
  /** To the chat the command was started in; after "open", the Bot's DM when that chat is gone. */
  const go = (fallback = false) => {
    const place = row.place;
    if (!place || !row.conversationId) {
      if (fallback) navigate({ name: "chat", botId: row.botId });
      return;
    }
    if (place.kind === "topic")
      navigate({ name: "chat", botId: row.botId, topicId: row.conversationId });
    else if (row.groupId)
      navigate({
        name: "chat",
        groupId: row.groupId,
        ...(place.kind === "thread" ? { threadId: row.conversationId } : {}),
      });
    else setError("backgroundLog.place.error");
  };
  const end = running ? undefined : ending(row, name, t);
  const where = placeLabel(row, t);
  return (
    <article className={styles.row} data-running={running || undefined}>
      <IconTile icon="terminal" tone="teal" size="lg" />
      <div className={styles.body}>
        <div className={styles.line}>
          <strong className={styles.bot} title={name}>
            {name}
          </strong>
          <code
            className={styles.command}
            title={t("backgroundLog.command", { command: row.command })}
          >
            {row.command}
          </code>
          <Chip tone={running ? "ok" : row.status === "failed" ? "danger" : "neutral"}>
            {running && <StatusDot state="running" className={styles.chipDot} />}
            {t(running ? "backgroundLog.running" : "backgroundLog.ended")}
          </Chip>
        </div>
        <div className={styles.meta}>
          <time dateTime={row.startedAt} title={started.toLocaleString(language)}>
            {t("backgroundLog.startedAt", { time: clock(started) })}
          </time>
          {running ? (
            <span>
              {t("backgroundLog.uptime", { duration: duration(now - started.getTime(), t) })}
            </span>
          ) : (
            ended && (
              <>
                <time dateTime={row.endedAt ?? undefined} title={ended.toLocaleString(language)}>
                  {t("backgroundLog.endedAt", { time: clock(ended) })}
                </time>
                <span>
                  {t("backgroundLog.ranFor", {
                    duration: duration(ended.getTime() - started.getTime(), t),
                  })}
                </span>
              </>
            )
          )}
          {/* While running, the action buttons carry the ports; listing them here too doubled the row. */}
          {running && !row.ports.length && (
            <span>{t(row.portsVisible ? "background.waitingPort" : "background.portHidden")}</span>
          )}
          {row.place && row.conversationId ? (
            <button
              type="button"
              className={styles.place}
              title={t("backgroundLog.place.go")}
              onClick={() => go()}
            >
              {where}
            </button>
          ) : (
            <span>{where}</span>
          )}
        </div>
        {end && (
          <div
            className={styles.meta}
            data-tone={row.stopReason === "exposed" || row.status === "failed" ? "warn" : undefined}
          >
            {end.by && <span>{t("backgroundLog.stoppedBy", { by: end.by })}</span>}
            <span>{t("backgroundLog.reason", { reason: end.reason })}</span>
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        )}
      </div>
      {running && (
        <div className={styles.actions}>
          <BackgroundPortButtons
            ports={row.ports}
            variant="ghost"
            buttonClassName={styles.button}
            disabled={!peer || busy !== undefined}
            onOpen={(port) => void act(port)}
            label={(port) => t("background.openPort", { port })}
          />
          <Button
            variant="secondary"
            className={styles.button}
            disabled={!peer || busy !== undefined}
            onClick={() => void act("stop")}
          >
            {busy === "stop" ? t("background.stopping") : t("background.stop")}
          </Button>
        </div>
      )}
    </article>
  );
}
