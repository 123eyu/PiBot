import { BotAvatar, useNavigation, useT } from "@pibot/renderer-kit";
import type { Bot, SkillDraft, SkillParam } from "@pibot/skills-contract/full";
import { Button, Icon } from "@pibot/ui";
import { type ReactNode, useState } from "react";
import styles from "./teach.module.css";
import type { useTeach } from "./use-teach.ts";

type Teach = ReturnType<typeof useTeach>;
const PARAM_NAME = /^[\p{L}\p{N}_]{1,40}$/u;
const PLACEHOLDER = /\{([\p{L}\p{N}_]{1,40})\}/gu;

/** A step line with its {parameter} placeholders shown as chips (design 整理). */
function StepLine({ line }: { line: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    parts.push(line.slice(last, at));
    parts.push(
      <span key={at} className={styles.chip}>
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  parts.push(line.slice(last));
  return <li>{parts}</li>;
}

function ParamRow({
  param,
  onChange,
  onRemove,
}: {
  param: SkillParam;
  onChange(next: SkillParam): void;
  onRemove(): void;
}) {
  const t = useT();
  const invalid = !PARAM_NAME.test(param.name);
  return (
    <div className={styles.paramRow}>
      <input
        className={styles.input}
        aria-label={t("teach.paramName")}
        aria-invalid={invalid || undefined}
        value={param.name}
        onChange={(event) => onChange({ ...param, name: event.target.value.trim() })}
      />
      <input
        className={styles.input}
        aria-label={t("teach.paramDefault")}
        placeholder={t("teach.noDefault")}
        value={param.default ?? ""}
        onChange={(event) => {
          const { default: _old, ...rest } = param;
          onChange(event.target.value ? { ...rest, default: event.target.value } : rest);
        }}
      />
      <button
        type="button"
        className={styles.stepToggle}
        aria-label={t("teach.removeParam", { name: param.name })}
        onClick={onRemove}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Step 2 (整理): edit the draft, try it once, then save. */
export function DraftEditor({ teach, bot }: { teach: Teach; bot: Bot | undefined }) {
  const t = useT();
  const { navigate } = useNavigation();
  const { draft, trial, routine, recording } = teach.snap;
  const [editing, setEditing] = useState(false);
  if (!draft) return null;
  const name = bot?.name ?? "";
  const set = (patch: Partial<SkillDraft>) =>
    teach.update((s) => ({ draft: s.draft && { ...s.draft, ...patch } }));
  const params = draft.params;
  const validParams =
    params.every((p) => PARAM_NAME.test(p.name)) &&
    new Set(params.map((p) => p.name)).size === params.length;
  const valid =
    !!draft.name.trim() && !!draft.description.trim() && !!draft.body.trim() && validParams;
  const { domains, writePaths, sendTo } = draft.permissions;
  const lines = draft.body
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[.、)]\s*/, ""))
    .filter((l) => l.trim());
  return (
    <div className={styles.stack}>
      <div className={styles.say}>
        <BotAvatar bot={bot} size={28} label={name} />
        <p className={styles.bubble}>
          {t("teach.draftIntro", { count: recording?.steps.length ?? lines.length })}
        </p>
      </div>
      <section className={styles.draft} aria-label={t("teach.stage.review")}>
        <div className={styles.draftHead}>
          <input
            className={`${styles.input} ${styles.nameInput}`}
            aria-label={t("teach.skillName")}
            value={draft.name}
            maxLength={80}
            onChange={(event) => set({ name: event.target.value })}
          />
          <span className={styles.tag}>{t("teach.taught")}</span>
          <input
            className={styles.input}
            aria-label={t("teach.description")}
            placeholder={t("teach.description")}
            value={draft.description}
            maxLength={1024}
            onChange={(event) => set({ description: event.target.value })}
          />
        </div>
        <div className={styles.draftBody}>
          <div className={styles.draftSteps}>
            <div className={styles.row}>
              <h3 className={styles.label}>{t("teach.stepsHeading")}</h3>
              <span className={styles.spacer} />
              <Button variant="ghost" className={styles.mini} onClick={() => setEditing(!editing)}>
                {t(editing ? "teach.doneEditing" : "teach.editSteps")}
              </Button>
            </div>
            {editing ? (
              <>
                <textarea
                  className={styles.textarea}
                  aria-label={t("teach.stepsHeading")}
                  value={draft.body}
                  rows={Math.min(16, Math.max(5, lines.length + 2))}
                  onChange={(event) => set({ body: event.target.value })}
                />
                <p className={styles.note}>{t("teach.stepsHelp")}</p>
              </>
            ) : (
              <ol className={styles.bodyList}>
                {lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
                  <StepLine key={i} line={line} />
                ))}
              </ol>
            )}
          </div>
          <div className={styles.draftSide}>
            <div className={styles.group}>
              <h3 className={styles.label}>{t("teach.params")}</h3>
              {params.length ? (
                params.map((param, i) => (
                  <ParamRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, names change
                    key={i}
                    param={param}
                    onChange={(next) => set({ params: params.map((p, j) => (j === i ? next : p)) })}
                    onRemove={() => set({ params: params.filter((_, j) => j !== i) })}
                  />
                ))
              ) : (
                <p className={styles.note}>{t("teach.noParams")}</p>
              )}
              {params.length < 20 && (
                <Button
                  variant="ghost"
                  className={styles.mini}
                  onClick={() => set({ params: [...params, { name: `p${params.length + 1}` }] })}
                >
                  <Icon name="plus" size={14} />
                  {t("teach.addParam")}
                </Button>
              )}
            </div>
            <div className={styles.group}>
              <h3 className={styles.label}>{t("teach.needs")}</h3>
              {domains.length > 0 && (
                <span>{t("teach.needs.sites", { list: domains.join(", ") })}</span>
              )}
              {writePaths.length > 0 && (
                <span>{t("teach.needs.write", { list: writePaths.join(", ") })}</span>
              )}
              {sendTo.length > 0 && (
                <span>{t("teach.needs.send", { list: sendTo.join(", ") })}</span>
              )}
              {!domains.length && !writePaths.length && !sendTo.length && (
                <span>{t("teach.needs.none")}</span>
              )}
              <p className={styles.note}>{t("teach.needsNote", { name })}</p>
            </div>
            <div className={styles.group}>
              <h3 className={styles.label}>{t("teach.trigger")}</h3>
              <label className={styles.check}>
                <input type="checkbox" checked disabled />
                {t("teach.trigger.chat")}
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={routine}
                  onChange={() => teach.update({ routine: !routine })}
                />
                {t("teach.trigger.routine")}
              </label>
            </div>
          </div>
        </div>
        {trial && (
          <div className={styles.trial} role="status" data-status={trial.status}>
            <span>
              {trial.status !== "running" && (
                <strong>
                  {t(trial.status === "done" ? "teach.trialDoneTitle" : "teach.trialFailedTitle")}
                </strong>
              )}
              {t(
                trial.status === "running"
                  ? "teach.trialStarted"
                  : trial.status === "done"
                    ? "teach.trialDone"
                    : "teach.trialFailed",
              )}
            </span>
            {trial.topicId && (
              <Button
                variant="secondary"
                className={styles.mini}
                onClick={() =>
                  navigate({
                    name: "chat",
                    botId: bot?.id,
                    topicId: trial.topicId,
                  })
                }
              >
                {t(trial.status === "running" ? "teach.openTrial" : "teach.openTrialChat")}
              </Button>
            )}
          </div>
        )}
        <div className={styles.draftFoot}>
          {!trial && <span className={styles.note}>{t("teach.saveFirstTrial")}</span>}
          {trial?.status === "running" && (
            <span className={styles.note}>{t("teach.saveDuringTrial")}</span>
          )}
          <span className={styles.spacer} />
          <Button variant="ghost" disabled={!!teach.busy} onClick={() => teach.discard(false)}>
            {t("teach.rerecord")}
          </Button>
          <Button
            variant="secondary"
            loading={teach.busy === "trial"}
            disabled={!valid || !!teach.busy || trial?.status === "running"}
            onClick={teach.trial}
          >
            {t(trial ? "teach.trialAgain" : "teach.trial")}
          </Button>
          <Button
            loading={teach.busy === "save"}
            disabled={!valid || !trial || !!teach.busy}
            onClick={teach.save}
          >
            {t("teach.save")}
          </Button>
        </div>
      </section>
    </div>
  );
}
