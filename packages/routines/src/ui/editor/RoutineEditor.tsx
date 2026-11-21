import {
  type Routine,
  type RoutineDraft,
  RoutineDraftSchema,
  RoutineOutputDefaults,
  RoutineOutputSchema,
  type RoutinePatch,
  type RoutinePreauthInput,
  RoutineTriggerInputSchema,
  WorkflowBindingSchema,
} from "@pibot/protocol";
import { FolderPicker, type Peer, useRpc, useSettings } from "@pibot/renderer-kit";
import { cronFieldIssue } from "@pibot/routines-contract";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePages } from "../page/paging.ts";
import { operationKey, PreauthEditor, useRoutinePermissions } from "../preauth/PreauthEditor.tsx";
import { preauthIssue } from "../preauth/preauth.ts";
import { useRoutineAction } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { triggerOffered, useTriggerSources } from "../triggers/ConnectionFields.tsx";
import { systemTimezone } from "../triggers/cron.ts";
import { TriggerEditor } from "../triggers/TriggerEditor.tsx";
import { OptionRow, RoutineOptions } from "./RoutineOptions.tsx";
import { Trial } from "./Trial.tsx";
import { useRoutineBot } from "./use-routine-bot.ts";
import { useRoutineFolders } from "./use-routine-folders.ts";

export function routineDraft(routine: Routine): RoutineDraft {
  return {
    botId: routine.botId,
    name: routine.name,
    instructions: routine.instructions,
    triggers: routine.triggers.map((t) => t.config),
    workplace: routine.workplace,
    preauth: routine.preauth.filter((p) => !p.revokedAt).map((p) => p.operation),
    notify: routine.notify,
    maxDurationMin: routine.maxDurationMin,
    carryLastResult: routine.carryLastResult,
    output: routine.output,
    workflow: routine.workflow,
    missedPolicy: routine.missedPolicy,
    enabled: routine.enabled,
  };
}
export interface RoutineEditorProps {
  initial?: RoutinePatch;
  saved?: Routine;
  botId?: string;
  disabled?: boolean;
  submitLabel?: string;
  onceRequest?: import("@pibot/protocol").OnceTimeInput;
  /** `trialRunId`: the last trial of this draft, whose conversation the new task adopts as its topic. */
  onSubmit(draft: RoutineDraft, options?: { trialRunId?: string }): Promise<void>;
  onDirtyChange?(dirty: boolean): void;
  onDraftChange?(draft: RoutineDraft): void;
}
// A caller can supply a partial proposal and its own resolve callback; no separate proposal form is needed.
export function RoutineEditor({
  initial,
  saved,
  botId,
  disabled,
  submitLabel,
  onceRequest,
  onSubmit,
  onDirtyChange,
  onDraftChange,
}: RoutineEditorProps) {
  const { t } = useSettings();
  const { peer } = useRpc();
  const [draft, setDraft] = useState<RoutineDraft>(() => ({
    botId: botId ?? "",
    name: "",
    instructions: "",
    workplace: { kind: "bot" },
    preauth: [],
    notify: "always",
    maxDurationMin: 30,
    carryLastResult: true,
    missedPolicy: null,
    enabled: true,
    ...initial,
    output: initial?.output ? RoutineOutputSchema.parse(initial.output) : RoutineOutputDefaults,
    workflow: initial?.workflow ? WorkflowBindingSchema.parse(initial.workflow) : null,
    triggers: onceRequest
      ? [{ kind: "once", at: "", timezone: onceRequest.timezone }]
      : initial
        ? (initial.triggers?.map((trigger) => RoutineTriggerInputSchema.parse(trigger)) ?? [])
        : [{ kind: "cron", expr: "30 8 * * *", timezone: systemTimezone() }],
  }));
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [trial, setTrial] = useState<{ id: string; botId: string; snapshot: string }>();
  const [trialRunning, setTrialRunning] = useState(false);
  // Preauthorization changes are the intended result of a trial, not a change to its task.
  const parsedTrialDraft = RoutineDraftSchema.safeParse(draft);
  const trialSnapshot = parsedTrialDraft.success
    ? JSON.stringify({ ...parsedTrialDraft.data, preauth: [] })
    : undefined;
  const currentTrial = !!trial && trial.botId === draft.botId && trial.snapshot === trialSnapshot;
  const action = useRoutineAction();
  const permissions = useRoutinePermissions(draft.botId);
  const folders = useRoutineFolders(
    draft.botId,
    draft.workplace,
    permissions.value?.places,
    (workplace) => update({ workplace }),
  );
  // Preauthorized writes are checked against this routine's own folders, not the Bot's.
  const context = useMemo(
    () =>
      permissions.value && folders.places
        ? { ...permissions, value: { ...permissions.value, places: folders.places } }
        : permissions,
    [permissions, folders.places],
  );
  const loadBots = useCallback(
    (peer: Peer, before?: string) => peer.call("bots.list", { before, limit: 50 }),
    [],
  );
  const bots = usePages(loadBots);
  const bot = useRoutineBot(draft.botId);
  const sources = useTriggerSources(draft.botId);
  const noBots =
    !bots.loading && !bots.error && !bots.more && !bots.rows.some((bot) => !bot.archivedAt);
  // A new routine starts with the main Bot (else the first one) instead of an unselectable
  // placeholder; until a Bot is chosen the work-place picker can only say "loading".
  const fallbackBot =
    bots.rows.find((row) => row.isMain && !row.archivedAt) ??
    bots.rows.find((row) => !row.archivedAt);
  useEffect(() => {
    if (draft.botId || !fallbackBot) return;
    setDraft((current) => (current.botId ? current : { ...current, botId: fallbackBot.id }));
  }, [draft.botId, fallbackBot]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);
  const update = (patch: Partial<RoutineDraft>) => {
    setDraft((old) => ({ ...old, ...patch }));
    setDirty(true);
    setInvalid(false);
  };
  const remember = (ops: RoutinePreauthInput[]) => {
    if (!currentTrial || !context.value || trialRunning) return;
    const snapshots = new Map(saved?.preauth.map((p) => [operationKey(p.operation), p]));
    const next = new Map(draft.preauth.map((op) => [operationKey(op), op]));
    for (const op of ops)
      if (
        next.size < 200 &&
        op.scope.kind !== "paid_image" &&
        !preauthIssue(
          op,
          context.value.permissions,
          context.value.places,
          snapshots.get(operationKey(op)),
        )
      )
        next.set(operationKey(op), op);
    update({ preauth: [...next.values()] });
  };
  const validate = () => {
    if (
      bot.blocked ||
      draft.triggers.some(
        (trigger) =>
          (trigger.kind === "cron" && cronFieldIssue(trigger.expr)) ||
          // The retired GitHub card and the cards of a connection, check or calendar
          // this Bot cannot use already say what to pick instead.
          trigger.kind === "github" ||
          !triggerOffered(trigger, sources.value),
      )
    )
      return undefined;
    const parsed = RoutineDraftSchema.safeParse(draft);
    if (!parsed.success || (draft.preauth.length > 0 && !context.value)) {
      setInvalid(true);
      return undefined;
    }
    return parsed.data;
  };
  return (
    <form
      className={styles.stack}
      onSubmit={(e) => {
        e.preventDefault();
        const value = validate();
        if (value && !disabled && !action.disabled && !trialRunning)
          void onSubmit(value, trial && currentTrial ? { trialRunId: trial.id } : {});
      }}
    >
      <fieldset className={styles.stack} disabled={disabled || action.disabled}>
        <section className={styles.formCard} data-mark="pink">
          <h2>{t("routines.section.what")}</h2>
          <label className={styles.field}>
            {t("routines.name")}
            <input
              required
              maxLength={40}
              value={draft.name}
              onChange={(e) => update({ name: e.currentTarget.value })}
            />
          </label>
          <label className={styles.field}>
            {t("routines.bot")}
            <select
              required
              value={draft.botId}
              onChange={(e) => {
                update({
                  botId: e.currentTarget.value,
                  preauth: [],
                  workplace: { kind: "bot" },
                  workflow: null,
                });
              }}
            >
              <option value="" disabled>
                {t("routines.bot")}
              </option>
              {draft.botId && !bots.rows.some((b) => b.id === draft.botId) && (
                <option value={draft.botId} disabled={bot.blocked}>
                  {bot.value?.name ?? draft.botId}
                </option>
              )}
              {bots.rows.map((bot) => (
                <option value={bot.id} key={bot.id} disabled={!!bot.archivedAt}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          {bot.value?.kind === "agent" && (
            <p role="note" className={styles.note}>
              {t("routines.agentExecutor")}
            </p>
          )}
          {bot.unsupported && (
            <p role="alert" className={styles.warn}>
              {t("media.routineReferencesUnsupported")}
            </p>
          )}
          {bot.error && (
            <p role="alert" className={styles.error}>
              {t(bot.error)} <Button onClick={bot.refresh}>{t("common.retry")}</Button>
            </p>
          )}
          {bots.more && (
            <Button variant="secondary" disabled={bots.loading} onClick={() => void bots.next()}>
              {t("routines.more")}
            </Button>
          )}
          {bots.error && (
            <p role="alert" className={styles.error}>
              {t(bots.error)} <Button onClick={bots.refresh}>{t("common.retry")}</Button>
            </p>
          )}
          {noBots && (
            <p role="status" className={styles.note}>
              {t("routines.noBots")}
            </p>
          )}
          {/* No workflow picker; the request below is planned on every run. A binding
            kept by migration 0102 (a saved plan, or a failed migration) is saved back unchanged. */}
          <label className={styles.field}>
            {t(draft.workflow ? "workflows.notesOptional" : "routines.instructions")}
            <textarea
              required={!draft.workflow}
              rows={5}
              maxLength={4000}
              value={draft.instructions}
              onChange={(e) => update({ instructions: e.currentTarget.value })}
            />
          </label>
        </section>
        <TriggerEditor
          botId={draft.botId}
          sources={sources}
          initialOnce={onceRequest?.localTime}
          key={`triggers-${draft.botId}`}
          disabled={!!disabled || action.disabled}
          values={draft.triggers}
          change={(triggers) => update({ triggers })}
        />
        {/* An agent's own requests are answered on a card each time; pre-approvals do not
          cover them, so the section is not offered for an agent Bot. */}
        {draft.botId && bot.value?.kind !== "agent" && (
          <PreauthEditor
            key={`preauth-${draft.botId}`}
            selected={draft.preauth}
            change={(preauth) => update({ preauth })}
            context={context}
            saved={saved?.preauth}
            imageModel={bot.value?.imageModel}
          />
        )}
        <section className={styles.formCard} data-mark="teal">
          <h2>{t("routines.section.run")}</h2>
          <div className={styles.optRows}>
            {/* A routine keeps its own folders, chosen with the chat's folder picker. */}
            <OptionRow
              icon="folder"
              tone="amber"
              label={t("routines.workplace")}
              note={t("workspace.boundaryNote")}
            >
              {folders.model ? (
                <FolderPicker
                  model={folders.model}
                  variant="field"
                  inherit={folders.inherit}
                  disabled={!!disabled || action.disabled || !draft.botId}
                  heading={t("routines.folders.title")}
                />
              ) : (
                <span className={styles.note}>{t("common.loading")}</span>
              )}
            </OptionRow>
            <RoutineOptions draft={draft} change={update} />
          </div>
        </section>
        <section className={styles.formCard} data-mark="orange">
          <h2>{t("routines.trialSetup")}</h2>
          <p className={styles.note}>{t("routines.trialSetupNote")}</p>
          <Button
            variant="secondary"
            disabled={bot.blocked || noBots || bots.loading || !!bots.error || trialRunning}
            onClick={() => {
              const value = validate();
              if (peer && value)
                void action
                  .run(() => peer.call("routines.trialRun", value))
                  .then((result) => {
                    if (result) {
                      setTrialRunning(true);
                      setTrial({
                        id: result.runId,
                        botId: value.botId,
                        snapshot: JSON.stringify({ ...value, preauth: [] }),
                      });
                    }
                  });
            }}
          >
            {t("routines.trial")}
          </Button>
        </section>
        {trial && (
          <Trial
            id={trial.id}
            botId={trial.botId}
            current={currentTrial}
            remember={remember}
            running={setTrialRunning}
            disabled={
              !!disabled || action.disabled || !context.value || bot.value?.kind === "agent"
            }
            imageReferencesUnsupported={bot.unsupported}
          />
        )}
        <div className={styles.formActions}>
          <Button
            type="submit"
            className={styles.toneButton}
            disabled={bot.blocked || noBots || bots.loading || !!bots.error || trialRunning}
          >
            {submitLabel ?? t("common.save")}
          </Button>
        </div>
      </fieldset>
      {invalid && (
        <p role="alert" className={styles.error}>
          {t("routines.invalid")}
        </p>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </form>
  );
}
