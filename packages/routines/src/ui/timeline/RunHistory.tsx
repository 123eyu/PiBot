import { AgentErrorCodeSchema, type MethodResults } from "@pibot/protocol";
import { type Peer, useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, type DotState, StatusDot } from "@pibot/ui";
import { useCallback } from "react";
import { routineTime } from "../format-time.ts";
import { usePages } from "../page/paging.ts";
import { routineRunTarget } from "../shell/locate.ts";
import { useRoutinesPorts } from "../shell/ports.tsx";
import { useRoutineAction, useRoutineRefresh } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { routineSummary } from "../shell/summary.ts";
import { RunLedger } from "./RunLedger.tsx";

export type RunView = MethodResults["routines.trialResult"];
export const activeRun = (run: RunView) =>
  run.status === "running" || run.status === "waiting" || run.status === "scheduled";
/** A stopped scheduled run can be continued by hand (never automatically). */
const resumable = (run: RunView) =>
  !!run.routineId && ["failed", "timeout", "cancelled"].includes(run.status);
export function runFailureKey(code: string) {
  if (code === "routine_preauth_reauthorization_required")
    return "routines.reauthorizationRequired" as const;
  if (code === "missed_too_old") return "routines.missedTooOld" as const;
  const parsed = AgentErrorCodeSchema.safeParse(code);
  return parsed.success ? (`errors.${parsed.data}` as const) : ("routines.failed" as const);
}
function runDot(status: RunView["status"]): DotState {
  if (status === "running") return "running";
  if (status === "done") return "done";
  if (status === "failed" || status === "timeout") return "failed";
  if (status === "waiting") return "waiting";
  if (status === "scheduled") return "queued";
  return "stopped";
}
export function RunRow({ run }: { run: RunView }) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const { navigate, closeSettings } = useNavigation();
  const action = useRoutineAction();
  const { RunReceipt } = useRoutinesPorts();
  const conversationId = run.conversationId;
  const executionId = run.runId;
  return (
    <div className={styles.runCard}>
      <div className={styles.row}>
        <StatusDot state={runDot(run.status)} />
        <strong>{routineTime(run.scheduledFor, language)}</strong>
        <span className={styles.tag}>
          {t(`routines.reason.${run.reason}`)} · {t(`routines.status.${run.status}`)}
          {run.resumeOf ? ` · ${t("routines.resumeRun.tag")}` : ""}
          {run.periodKey ? ` · ${run.periodKey}` : ""}
        </span>
      </div>
      {run.summary && <p className={styles.note}>{routineSummary(run.summary)}</p>}
      {run.errorCode && <p className={styles.error}>{t(runFailureKey(run.errorCode))}</p>}
      {!activeRun(run) && run.runId && <RunReceipt runId={run.runId} />}
      <p className={styles.note}>
        {t("routines.elapsed", {
          active: Math.floor(run.activeMs / 1000),
          waiting: Math.floor(run.waitingMs / 1000),
        })}
      </p>
      <div className={styles.row}>
        <Button
          variant="secondary"
          disabled={action.disabled || !run.conversationId}
          onClick={() => {
            if (peer && conversationId)
              void action
                .run((signal) => routineRunTarget(peer, run, signal))
                .then((view) => {
                  if (view) {
                    closeSettings();
                    navigate(view);
                  }
                });
          }}
        >
          {t("routines.openTopic")}
        </Button>
        {activeRun(run) && (
          <Button
            variant="secondary"
            disabled={action.disabled || !run.runId}
            onClick={() => {
              if (peer && executionId)
                void action.run(() => peer.call("chat.abort", { runId: executionId }));
            }}
          >
            {t("routines.stop")}
          </Button>
        )}
        {resumable(run) && (
          <Button
            variant="secondary"
            disabled={action.disabled}
            onClick={() => {
              if (peer) void action.run(() => peer.call("routines.resumeRun", { id: run.id }));
            }}
          >
            {t("routines.resumeRun")}
          </Button>
        )}
      </div>
      {run.reason !== "trial" && <RunLedger id={run.id} />}
      {action.error && (
        <p className={styles.error} role="alert">
          {t(action.error)}
        </p>
      )}
    </div>
  );
}
export function RunHistory({ routineId, botId }: { routineId: string; botId: string }) {
  const { t } = useSettings();
  const load = useCallback(
    async (peer: Peer, before?: string) => {
      const rows = await peer.call("routines.runs", { id: routineId, before, limit: 50 });
      if (rows.some((r) => r.routineId !== routineId)) throw new Error("Run ownership mismatch");
      return rows;
    },
    [routineId],
  );
  const page = usePages(load);
  useRoutineRefresh(page.refresh, botId, { routineId });
  return (
    <section className={styles.formCard} data-mark="orange">
      <h2>{t("routines.history")}</h2>
      {page.rows.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
      {!page.loading && !page.error && !page.rows.length && (
        <p className={styles.note}>{t("routines.none")}</p>
      )}
      {page.loading && <p role="status">{t("common.loading")}</p>}
      {page.error && (
        <p role="alert" className={styles.error}>
          {t(page.error)} <Button onClick={page.refresh}>{t("common.retry")}</Button>
        </p>
      )}
      {page.more && (
        <Button variant="secondary" disabled={page.loading} onClick={() => void page.next()}>
          {t("routines.more")}
        </Button>
      )}
    </section>
  );
}
