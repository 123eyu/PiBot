import type { ConnectionTrigger, MethodResults } from "@pibot/protocol";
import { type Peer, useNavigation, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useCallback } from "react";
import { useRemote } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";

export type TriggerSources = MethodResults["routines.triggerSources"];

/** What this Bot can watch: connections with their preset checks, and the local calendar. */
export function useTriggerSources(botId: string) {
  const load = useCallback(
    (peer: Peer, signal: AbortSignal) =>
      botId
        ? peer.call("routines.triggerSources", { botId }, { signal })
        : Promise.resolve<TriggerSources>({ connections: [], calendars: [], blocked: [] }),
    [botId],
  );
  const sources = useRemote(load);
  useRpcEvent("connectors.changed", sources.refresh);
  return sources;
}

/**
 * Whether this Bot is offered the trigger's connection and check (or calendar) right now; a
 * card that shows 「原来选的连接已不可用」 is not saved. Other kinds are always offered.
 */
export function triggerOffered(
  trigger: { kind: string; connectorId?: string; check?: string },
  sources: TriggerSources | undefined,
) {
  if (trigger.kind === "connection")
    return !!sources?.connections.some(
      (row) =>
        row.connectorId === trigger.connectorId &&
        row.checks.some((check) => check === trigger.check),
    );
  if (trigger.kind === "calendar")
    return !!sources?.calendars.some((row) => row.connectorId === trigger.connectorId);
  return true;
}

/** The first connection and check the button adds; the person can change both on the card. */
export function firstConnectionCheck(sources: TriggerSources | undefined) {
  for (const connection of sources?.connections ?? [])
    for (const check of connection.checks) return { connectorId: connection.connectorId, check };
  return undefined;
}

const INTERVALS = [5, 15, 60] as const;

export function ConnectionFields({
  value,
  change,
  sources,
  disabled,
}: {
  value: ConnectionTrigger;
  change(next: ConnectionTrigger): void;
  sources: TriggerSources | undefined;
  disabled?: boolean;
}) {
  const { t } = useSettings();
  const { navigate } = useNavigation();
  const selected = `${value.connectorId}|${value.check}`;
  const known = sources?.connections.some(
    (row) => row.connectorId === value.connectorId && row.checks.includes(value.check),
  );
  return (
    <>
      <div className={styles.field}>
        <span className={styles.label}>{t("routines.connection.what")}</span>
        <div className={styles.chips}>
          {!known && (
            <button type="button" className={styles.chip} aria-pressed disabled>
              {sources ? t("routines.connection.missing") : t("common.loading")}
            </button>
          )}
          {sources?.connections.map((row) =>
            row.checks.length ? (
              row.checks.map((check) => (
                <button
                  key={`${row.connectorId}|${check}`}
                  type="button"
                  className={styles.chip}
                  disabled={disabled}
                  aria-pressed={selected === `${row.connectorId}|${check}`}
                  onClick={() => change({ ...value, connectorId: row.connectorId, check })}
                >
                  {`${row.name} · ${t(`routines.check.${check}`)}`}
                </button>
              ))
            ) : (
              <button key={row.connectorId} type="button" className={styles.chip} disabled>
                {`${row.name} · ${t("routines.connection.noCheck")}`}
              </button>
            ),
          )}
        </div>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>{t("routines.connection.every")}</span>
        <SegmentedControl
          className={styles.seg}
          label={t("routines.connection.every")}
          disabled={disabled}
          value={String(value.intervalMin)}
          options={INTERVALS.map((minutes) => ({
            value: String(minutes),
            label: t("routines.connection.minutes", { minutes }),
          }))}
          onValueChange={(minutes) =>
            change({
              ...value,
              intervalMin: Number(minutes) as ConnectionTrigger["intervalMin"],
            })
          }
        />
      </div>
      <p className={styles.note}>{t("routines.connection.hint")}</p>
      {sources && !known && (
        <p className={styles.warn}>
          {t("routines.connection.missing")}{" "}
          <Button variant="ghost" onClick={() => navigate({ name: "connectors" })}>
            {t("connectors.title")}
          </Button>
        </p>
      )}
    </>
  );
}
