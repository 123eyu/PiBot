import { routineRunName, routineRunStatus, safeAuditText } from "@pibot/client-core";
import type { RoutineHistoryView } from "@pibot/protocol";
import { useAction, useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { routineSummary } from "@pibot/routines/ui";
import { Chip, Icon, StatusDot } from "@pibot/ui";
import { useEffect, useRef } from "react";
import { RunLogButton } from "../run-log/Viewer.tsx";
import styles from "./audit.module.css";
import { locateRoutineRun } from "./run-navigation.ts";

export function RoutineRunDetails({ run }: { run: RoutineHistoryView }) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const { navigate } = useNavigation();
  const task = useAction();
  const owner = useRef(new AbortController());
  // biome-ignore lint/correctness/useExhaustiveDependencies: Peer/run replacement must cancel old navigation even when the component stays mounted.
  useEffect(() => {
    const lifetime = new AbortController();
    owner.current = lifetime;
    return () => lifetime.abort();
  }, [peer, run.id]);
  const result = routineRunStatus(run, t);
  const name = routineRunName(run, t);
  const canLocate =
    !!run.conversationId &&
    !!run.triggerMessageId &&
    (run.reason === "trial" || (!!run.routineId && !!run.taskName && !run.taskDeleted));
  const openChat = () => {
    if (!peer || !canLocate) return;
    const signal = AbortSignal.any([owner.current.signal, AbortSignal.timeout(30_000)]);
    void task
      .run(
        (lifetime) => locateRoutineRun(peer, run, AbortSignal.any([signal, lifetime])),
        () => "activity.chatUnavailable",
      )
      .then((target) => {
        if (target && !signal.aborted) navigate(target);
      });
  };
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(language) : t("activity.routineNotStarted");
  const facts = [
    [t("activity.routineTask"), name],
    [t("audit.bot"), safeAuditText(run.bot?.name ?? "", 200) || t("activity.routineBotMissing")],
    [t("activity.routineReason"), t(`routines.reason.${run.reason}`)],
    [t("activity.routineCreated"), date(run.createdAt)],
    [t("activity.routineStarted"), date(run.startedAt)],
    [
      t("activity.routineActive"),
      t("activity.routineSeconds", { seconds: (run.activeMs / 1000).toFixed(1) }),
    ],
    [
      t("activity.routineWaiting"),
      t("activity.routineSeconds", { seconds: (run.waitingMs / 1000).toFixed(1) }),
    ],
    ...(run.finishedAt ? [[t("activity.routineFinished"), date(run.finishedAt)]] : []),
  ];
  return (
    <div className={styles.details}>
      <div className={styles.detailStatus}>
        <Chip tone="orange">{t("activity.kind.scheduling")}</Chip>
        <span className={styles.result} data-tone={result.tone}>
          {result.text}
        </span>
      </div>
      {/* Created → started → finished at a glance; the exact times stay in the facts. */}
      <ol className={styles.runSteps}>
        {(
          [
            ["activity.routineCreated", run.createdAt],
            ["activity.routineStarted", run.startedAt],
            ["activity.routineFinished", run.finishedAt],
          ] as const
        ).map(([label, at], index) => (
          <li key={label} data-reached={!!at || undefined}>
            <StatusDot
              state={
                !at
                  ? "queued"
                  : index === 2 && result.tone === "danger"
                    ? "failed"
                    : index === 1 && !run.finishedAt
                      ? "running"
                      : "done"
              }
            />
            <strong>{t(label)}</strong>
            <time>
              {at
                ? new Date(at).toLocaleTimeString(language, { hour12: false })
                : t("activity.routineNotStarted")}
            </time>
          </li>
        ))}
      </ol>
      <pre className={styles.runSummary}>
        {safeAuditText(routineSummary(run.summary ?? ""), 2000) || t("activity.routineNoSummary")}
      </pre>
      <dl className={styles.facts}>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.links}>
        <button
          type="button"
          className={styles.primaryLink}
          disabled={!peer || task.busy || !canLocate}
          onClick={openChat}
        >
          {t("activity.routineOpenChat")} <Icon name="arrow" size={13} />
        </button>
        {run.runId ? (
          <RunLogButton
            label={t("activity.routineOpenOutput")}
            details={{
              runId: run.runId,
              botId: run.botId,
              command: name,
              exitCode: null,
              durationMs: run.activeMs,
            }}
          />
        ) : (
          <button type="button" disabled>
            {t("activity.routineOpenOutput")}
          </button>
        )}
      </div>
      {!canLocate && <p className={styles.note}>{t("activity.chatUnavailable")}</p>}
      {!run.runId && <p className={styles.note}>{t("activity.routineNoOutput")}</p>}
      {task.busy && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {task.error && (
        <p className={styles.danger} role="alert">
          {t(task.error)}
        </p>
      )}
    </div>
  );
}
