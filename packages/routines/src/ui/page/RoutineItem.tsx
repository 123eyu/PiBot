import { isIndefinitePause, type Routine } from "@pibot/protocol";
import { BotAvatar, useRpc, useSettings } from "@pibot/renderer-kit";
import { Chip, StatusDot, Switch, type Tone } from "@pibot/ui";
import type { RoutineBot } from "../editor/use-routine-bot.ts";
import { routineTime } from "../format-time.ts";
import { useRoutineAction } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { routineSummary } from "../shell/summary.ts";
import { runFailureKey } from "../timeline/RunHistory.tsx";
import { appTriggerText, hasRetiredTrigger, watchesEvents } from "../triggers/app-trigger-text.ts";
import { cronText } from "../triggers/cron.ts";
import { onceText } from "../triggers/once.ts";
import type { RoutineRowState } from "./rows.ts";
export function RoutineItem({
  routine,
  bot,
  state,
  pausedUntil,
  asOf,
  open,
}: {
  routine: Routine;
  /** Loaded once per Bot by the list (useRoutineBots). */
  bot: RoutineBot | undefined;
  state?: RoutineRowState;
  pausedUntil?: string | null;
  asOf?: string;
  open(): void;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const action = useRoutineAction();
  const referencesUnsupported = bot?.category === "image" && !bot.imageScheduleAvailable;
  const enablingBlocked = !bot || referencesUnsupported || !!routine.authorizationError;
  const recent = state?.lastResult ?? state?.onceOutcome;
  const status = state?.active?.status;
  const paused = pausedUntil && new Date(pausedUntil) > new Date(asOf ?? Date.now());
  const consumed =
    routine.triggers.length === 1 &&
    routine.triggers[0]?.config.kind === "once" &&
    !!routine.triggers[0].state.consumedAt;
  const inactiveLabel = routine.authorizationError
    ? t("routines.reauthorizationRequired")
    : !routine.enabled
      ? t("routines.disabled")
      : routine.pausedReason
        ? t(`routines.paused.${routine.pausedReason}`)
        : paused
          ? isIndefinitePause(pausedUntil)
            ? t("routines.pausedIndefinitely")
            : t("routines.pausedUntil", { time: routineTime(pausedUntil, language) })
          : consumed
            ? state?.onceOutcome
              ? t(`routines.status.${state.onceOutcome.status}`)
              : t("routines.once.consumed")
            : t("routines.idle");
  const stateLabel = !state
    ? t("routines.statusUnknown")
    : status
      ? t(`routines.status.${status}`)
      : inactiveLabel;
  // C6: the state label already says why nothing is scheduled next, so "next" only reports a
  // time (or the trigger kind) instead of repeating the same sentence a second time.
  const schedulingStopped =
    !!routine.authorizationError || !routine.enabled || !!routine.pausedReason || !!paused;
  const nextLabel = !state
    ? t("routines.nextUnknown")
    : schedulingStopped
      ? t("routines.nextPaused")
      : state.nextAt
        ? routineTime(state.nextAt, language)
        : routine.triggers.some((trigger) => watchesEvents(trigger.config))
          ? t("routines.onChange")
          : t("routines.noPlan");
  // The card's top edge carries what needs attention first — running, waiting, failing, off.
  const tone: Tone =
    status === "running"
      ? "blue"
      : status === "waiting" || routine.authorizationError
        ? "amber"
        : schedulingStopped || consumed
          ? "neutral"
          : recent?.status === "failed" || recent?.status === "timeout"
            ? "red"
            : "orange";
  return (
    <div className={styles.item} data-tone={tone}>
      <BotAvatar
        bot={bot}
        unknown={!bot}
        size={32}
        state={
          status === "running"
            ? "working"
            : status === "waiting"
              ? "waiting"
              : status === "scheduled"
                ? "thinking"
                : "idle"
        }
        label={`${bot?.name ?? routine.botId} · ${stateLabel}`}
      />
      <button type="button" className={styles.open} onClick={open}>
        <strong className={styles.itemTitle}>{routine.name}</strong>
        <span className={styles.note}>{bot?.name ?? routine.botId}</span>
        <Chip
          tone={tone === "red" ? "danger" : tone === "orange" ? "neutral" : tone}
          className={styles.stateChip}
        >
          {status && (
            <StatusDot
              state={
                status === "running" ? "running" : status === "scheduled" ? "queued" : "waiting"
              }
            />
          )}
          {stateLabel}
        </Chip>
        <span className={styles.note}>
          {routine.triggers
            .map((trigger) =>
              trigger.config.kind === "cron"
                ? cronText(trigger.config.expr, trigger.config.timezone, language)
                : trigger.config.kind === "once"
                  ? `${t("routines.once")} · ${onceText(trigger.config.at, trigger.config.timezone, language)}`
                  : trigger.config.kind === "folder"
                    ? `${t("routines.onChange")} · ${trigger.config.path}`
                    : appTriggerText(trigger.config, t),
            )
            .join(" / ")}
        </span>
        {routine.authorizationError && (
          <span className={styles.warn}>
            {t("routines.reauthorizationRequired")} · {t("routines.reauthorizationHint")}
          </span>
        )}
        {referencesUnsupported && (
          <span className={styles.warn}>{t("media.routineReferencesUnsupported")}</span>
        )}
        {(routine.preauth.some((record) => record.invalidReason === "workspace") ||
          state?.workspaceUnavailable === "workspace") && (
          <span className={styles.warn}>
            {/* Naming the folder is what lets the person fix it; the task itself opens the editor. */}
            {state?.workspaceMissing?.length
              ? t("routines.workspaceUnavailableFolders", {
                  folders: state.workspaceMissing.join(language === "zh" ? "、" : ", "),
                })
              : t("routines.workspaceUnavailable")}
          </span>
        )}
        {/* The run skips a deleted reference folder, so this is a note, not a failure. */}
        {!!state?.workspaceReferenceMissing?.length && (
          <span className={styles.warn}>
            {t("routines.workspaceReferenceMissing", {
              folders: state.workspaceReferenceMissing.join(language === "zh" ? "、" : ", "),
            })}
          </span>
        )}
        {/* Re-picking the folder cannot fix an offline target, so it gets its own words. */}
        {(routine.preauth.some((record) => record.invalidReason === "runner") ||
          state?.workspaceUnavailable === "runner") && (
          <span className={styles.warn}>{t("routines.runnerUnavailable")}</span>
        )}
        {hasRetiredTrigger(routine.triggers.map((trigger) => trigger.config)) && (
          <span className={styles.warn}>{t("routines.githubRetired")}</span>
        )}
        <span className={styles.note}>
          {t("routines.last")} ·{" "}
          {recent
            ? `${routineTime(recent.finishedAt ?? recent.scheduledFor, language)} · ${t(`routines.status.${recent.status}`)}${recent.reason === "catchup" ? ` · ${t("routines.reason.catchup")}` : ""}`
            : state
              ? t("routines.none")
              : t("routines.statusUnknown")}
        </span>
        {/* Maintainers 2026-11-19: a long result made its row tall; three lines here, the rest on open. */}
        {recent?.summary && (
          <>
            <span className={styles.itemSummary}>
              <span>{routineSummary(recent.summary)}</span>
            </span>
            <span className={styles.itemMore}>{t("routines.viewAll")}</span>
          </>
        )}
        {!!state?.attentionCount && (
          <span className={styles.warn}>
            {t("routines.attention", { count: state.attentionCount })}
          </span>
        )}
        {recent?.errorCode && (
          <span className={styles.error}>{t(runFailureKey(recent.errorCode))}</span>
        )}
        <span className={styles.itemNext}>
          {t("routines.next")} · {nextLabel}
        </span>
      </button>
      <Switch
        label={`${t("routines.enabled")} · ${routine.name}`}
        checked={routine.enabled}
        disabled={
          action.disabled ||
          !!routine.deletedAt ||
          (!routine.enabled && (enablingBlocked || !!consumed))
        }
        onCheckedChange={(enabled) => {
          if (peer && (!enabled || !enablingBlocked))
            void action.run(() => peer.call("routines.setEnabled", { id: routine.id, enabled }));
        }}
      />
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </div>
  );
}
