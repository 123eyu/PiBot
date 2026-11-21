import { approvalText } from "@pibot/client-core";
import type { InboxItem } from "@pibot/protocol";
import { useRpc, useSettings } from "@pibot/renderer-kit";
import { useRoutineAction, useRoutineNavigation } from "@pibot/routines/ui";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { ApprovalCard } from "../../chat/tools/ApprovalCard.tsx";
import styles from "./inbox.module.css";

export type RoutineInboxItem = Extract<
  InboxItem,
  { kind: "routine_approval" | "routine_missed" | "routines_paused_away" | "routine_trigger_error" }
>;
export function RoutineInboxCard({
  item,
  refresh,
  record,
}: {
  item: RoutineInboxItem;
  refresh(): Promise<void>;
  record(item: InboxItem): void;
}) {
  const { peer } = useRpc(),
    { t, language } = useSettings(),
    { openRoutines } = useRoutineNavigation();
  const action = useRoutineAction();
  const [future, setFuture] = useState<"" | "catchup" | "skip" | "ask">("");
  const [restored, setRestored] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const missed = item.kind === "routine_missed" ? item.run : undefined;
  const tooOld =
    !!missed &&
    (missed.errorCode === "missed_too_old" ||
      Date.now() - Date.parse(missed.scheduledFor) > 86400000);
  const title =
    item.kind === "routine_approval"
      ? approvalText(item.approval, language).title
      : item.kind === "routine_missed"
        ? t("routines.missedCard")
        : item.kind === "routines_paused_away"
          ? t("routines.awayCard", { count: item.count })
          : t("routines.triggerErrorCard", { name: item.routine.name });
  async function resolveMissed(mode: "catchup" | "skip") {
    if (!peer || !missed) return;
    const result = await action.run(async () => {
      const resolved = await peer.call("routines.missed.resolve", {
        runId: missed.id,
        action: mode,
        ...(future ? { missedPolicy: future } : {}),
      });
      if (
        resolved.id !== missed.id ||
        resolved.routineId !== missed.routineId ||
        resolved.status === "missed"
      )
        throw new Error("Missed run receipt changed");
      return resolved;
    });
    if (result) {
      record({ ...item, kind: "routine_missed", run: result });
      setAcknowledged(true);
      await refresh();
    }
  }
  return (
    <article className={styles.card} aria-label={title}>
      <header className={styles.cardHeader}>
        <strong>{title}</strong>
      </header>
      {item.kind === "routine_approval" ? (
        <div className={styles.approvalBody}>
          <ApprovalCard
            inbox
            conversationId={item.conversationId}
            approval={item.approval}
            refresh={refresh}
            decide={async (id, decision, remember, preauthorize) => {
              if (!peer) throw new Error("Disconnected");
              // Routine approvals never persist secret consent.
              await peer.call("approvals.resolve", {
                id,
                decision,
                remember: item.approval.rememberOnly === "secrets" ? false : remember,
                preauthorize,
              });
            }}
          />
        </div>
      ) : missed ? (
        <div className={styles.memoryBody}>
          <time dateTime={missed.scheduledFor}>
            {new Date(missed.scheduledFor).toLocaleString(language)}
          </time>
          {!acknowledged &&
          (missed.status === "missed" ||
            (missed.status === "skipped_missed" && missed.errorCode === "missed_too_old")) ? (
            <>
              {tooOld && <p>{t("routines.missedTooOld")}</p>}
              <label>
                {t("routines.futureMissed")}{" "}
                <select
                  value={future}
                  disabled={action.disabled}
                  onChange={(event) => setFuture(event.currentTarget.value as typeof future)}
                >
                  <option value="">{t("routines.futureUnchanged")}</option>
                  <option value="catchup">{t("routines.futureCatchup")}</option>
                  <option value="skip">{t("routines.futureSkip")}</option>
                  <option value="ask">{t("routines.futureAsk")}</option>
                </select>
              </label>
              <div className={styles.links}>
                <Button disabled={action.disabled} onClick={() => void resolveMissed("skip")}>
                  {t("routines.skipOnce")}
                </Button>
                {missed.status === "missed" && !tooOld && (
                  <Button disabled={action.disabled} onClick={() => void resolveMissed("catchup")}>
                    {t("routines.catchupNow")}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p role="status">{t(`routines.status.${missed.status}`)}</p>
          )}
        </div>
      ) : item.kind === "routines_paused_away" ? (
        <div className={styles.memoryBody}>
          <p role="status">{t(restored ? "routines.awayRestored" : "routines.away")}</p>
          {!restored && (
            <Button
              disabled={action.disabled}
              onClick={() => {
                if (peer)
                  void action.run(async (signal) => {
                    await peer.call("routines.resumeAway", {});
                    const summary = await peer.call("routines.summary", undefined);
                    signal.throwIfAborted();
                    if (!summary.counts.awayPaused) setRestored(true);
                    await refresh();
                  });
              }}
            >
              {t("routines.resumeAwayAll")}
            </Button>
          )}
        </div>
      ) : (
        <p className={styles.result}>{t("routines.triggerErrorNote")}</p>
      )}
      <div className={styles.links}>
        <Button
          disabled={action.busy}
          onClick={() =>
            openRoutines(
              item.kind === "routine_trigger_error"
                ? item.routine.id
                : (missed?.routineId ?? undefined),
            )
          }
        >
          {t("routines.reviewTask")}
        </Button>
      </div>
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </article>
  );
}
