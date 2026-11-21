import { useAction, useRpc, useSettings } from "@pibot/renderer-kit";
import type { Skill, WorkflowSummary } from "@pibot/skills-contract/full";
import { Button, Switch } from "@pibot/ui";
import { useRef, useState } from "react";
import { useSkillsPorts } from "../shell/ports.tsx";
import { skillError } from "./presentation.ts";
import { SkillMain, WorkflowWarnings } from "./SkillRowParts.tsx";
import styles from "./skills.module.css";

/**
 * 「常用计划」: the group member's workflows saved from a passed dynamic plan
 * (`skill.savedFromPlan`, recorded only by that save path). Workflows of any other origin (saved
 * from a run, made in the editor, copied methods) are 「我的技能」. Run, rename and delete use the
 * ordinary skill RPCs, so a plan is still just one of its skills.
 */
export function SavedPlans({
  rows,
  workflows,
  groupId,
  botName,
  disabled,
  loading,
  failed,
  retry,
  open,
  run,
  edit,
  changed,
}: {
  rows: readonly Skill[];
  workflows: ReadonlyMap<string, WorkflowSummary>;
  groupId?: string;
  botName: string;
  disabled: boolean;
  loading: boolean;
  failed: boolean;
  retry(): void;
  open(skillId: string): void;
  run?(skillId: string): void;
  edit(skillId: string): void;
  changed(skill?: Skill): void;
}) {
  const { t } = useSettings();
  const { PanelMenu } = useSkillsPorts();
  const { peer } = useRpc();
  const task = useAction();
  const [renaming, setRenaming] = useState<{ skill: Skill; name: string }>();
  const [removing, setRemoving] = useState<Skill>();
  // A retried rename keeps its request id, so a lost reply cannot apply the same change twice.
  const renameAttempt = useRef<{ key: string; requestId: string } | undefined>(undefined);
  const busy = disabled || task.busy;
  const rename = async () => {
    if (!peer || !renaming) return;
    const name = renaming.name.trim();
    if (!name || name === renaming.skill.name) {
      setRenaming(undefined);
      return;
    }
    const key = `${renaming.skill.id}:${name}`;
    const attempt =
      renameAttempt.current?.key === key
        ? renameAttempt.current
        : { key, requestId: crypto.randomUUID() };
    renameAttempt.current = attempt;
    const result = await task.run(
      () =>
        peer.call("skills.update", {
          groupId,
          skillId: renaming.skill.id,
          requestId: attempt.requestId,
          patch: { name },
        }),
      skillError,
    );
    if (!result) return;
    renameAttempt.current = undefined;
    setRenaming(undefined);
    changed(result);
  };
  const remove = async () => {
    if (!peer || !removing) return;
    const skillId = removing.id;
    const result = await task.run(
      () => peer.call("skills.delete", { groupId, skillId, confirmed: true }),
      skillError,
    );
    if (!result) return;
    setRemoving(undefined);
    changed();
  };
  return (
    <section className={styles.section} aria-label={t("skills.section.plans")}>
      <div className={styles.head}>
        <h2>{t("skills.section.plans")}</h2>
      </div>
      {!!rows.length && (
        <div className={styles.list}>
          {rows.map((skill) => {
            const workflow = workflows.get(skill.id);
            return (
              <div key={skill.id} className={styles.row} data-enabled={skill.enabled}>
                <SkillMain skill={skill} workflow={workflow} open={() => open(skill.id)} />
                {run && skill.enabled && workflow?.contract && (
                  <Button
                    variant="pill"
                    className={styles.mini}
                    disabled={busy}
                    onClick={() => run(skill.id)}
                  >
                    {t("workflows.run")}
                  </Button>
                )}
                <PanelMenu
                  label={t("skills.planActions", { name: skill.name })}
                  disabled={busy}
                  items={[
                    ...(workflow?.contract
                      ? [
                          {
                            id: "edit",
                            label: t("workflows.editor.edit"),
                            run: () => edit(skill.id),
                          },
                        ]
                      : []),
                    {
                      id: "rename",
                      label: t("skills.rename"),
                      run: () => {
                        setRemoving(undefined);
                        setRenaming({ skill, name: skill.name });
                      },
                    },
                    {
                      id: "delete",
                      label: t("skills.delete"),
                      danger: true,
                      run: () => {
                        setRenaming(undefined);
                        setRemoving(skill);
                      },
                    },
                  ]}
                />
                <Switch
                  label={t("skills.enable", { name: skill.name })}
                  checked={skill.enabled}
                  disabled={busy}
                  onCheckedChange={async (enabled) => {
                    if (!peer) return;
                    const result = await task.run(
                      () => peer.call("skills.setEnabled", { groupId, skillId: skill.id, enabled }),
                      skillError,
                    );
                    if (result?.id === skill.id) changed(result);
                  }}
                />
                <WorkflowWarnings workflow={workflow} />
              </div>
            );
          })}
        </div>
      )}
      {renaming && (
        <form
          className={styles.confirm}
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <label className={styles.field}>
            {t("skills.renameLabel")}
            <input
              value={renaming.name}
              maxLength={80}
              disabled={task.busy}
              onChange={(event) => {
                const name = event.currentTarget.value;
                setRenaming((current) => current && { ...current, name });
              }}
            />
          </label>
          <div className={styles.actions}>
            <Button
              type="submit"
              variant="primary"
              className={styles.mini}
              loading={task.busy}
              disabled={!peer || !renaming.name.trim()}
            >
              {t("common.save")}
            </Button>
            <Button
              variant="ghost"
              className={styles.mini}
              disabled={task.busy}
              onClick={() => setRenaming(undefined)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      )}
      {removing && (
        <div className={styles.confirm}>
          <p>{t("skills.deleteConfirm", { name: removing.name, bot: botName })}</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              className={styles.deleteButton}
              loading={task.busy}
              disabled={!peer}
              onClick={() => void remove()}
            >
              {t("skills.delete")}
            </Button>
            <Button variant="ghost" disabled={task.busy} onClick={() => setRemoving(undefined)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
      {loading && !rows.length && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {failed && (
        <p role="alert" className={styles.error}>
          {t("skills.plansFailed")}{" "}
          <Button variant="pill" onClick={retry}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!loading && !failed && !rows.length && (
        <p className={styles.note}>{t("skills.plansEmpty")}</p>
      )}
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
    </section>
  );
}
