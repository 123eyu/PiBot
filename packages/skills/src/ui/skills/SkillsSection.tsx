import { useAction, useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import type { Skill } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSkillsPorts } from "../shell/ports.tsx";
import { useWorkflows } from "../workflows/use-workflows.ts";
import { WorkflowEditorDialog } from "../workflows/WorkflowEditorDialog.tsx";
import { WorkflowRunDialog } from "../workflows/WorkflowRunDialog.tsx";
import { ConnectionPicker } from "./ConnectionPicker.tsx";
import { skillError } from "./presentation.ts";
import { SavedPlans } from "./SavedPlans.tsx";
import { SkillDetail } from "./SkillDetail.tsx";
import { ListFooter, SkillRow } from "./SkillRowParts.tsx";
import styles from "./skills.module.css";
import { useRoleName } from "./use-role-name.ts";
import { useSkillPage } from "./use-skill-page.ts";

/**
 * 「技能」 tab body: 「我的技能」 (the Bot's or group member's assigned skills, including built-in
 * planning references), then 「常用计划」. Adding is
 * only teaching or picking what the connections page already has (maintainers 2026-11-01); writing,
 * bringing over and importing skills or MCP happen on the connections page.
 */
export function SkillsSection({
  botId,
  groupId,
  botName,
  archived,
  send,
  teach,
  conversationId,
  allowWorkflowRun = false,
  connections = true,
  pendingImports,
  focusSkillId,
}: {
  botId: string;
  groupId?: string;
  botName: string;
  archived: boolean;
  send?(text: string): Promise<boolean>;
  /** 「教它做一次」 entry; the teach page supplies it. */
  teach?(): void;
  /** Bot profile: run in its currently open private topic; group: the group's current topic. */
  conversationId?: string;
  allowWorkflowRun?: boolean;
  /** Whether 「从连接选择」 offers MCP too (image Bots call no tools). */
  connections?: boolean;
  /** Imported skills still waiting for a target, shown at the top of the list. */
  pendingImports?: ReactNode;
  /** Opens with this skill's detail expanded (the teach page's "view this skill"). */
  focusSkillId?: string;
}) {
  const { t } = useSettings();
  const { PanelMenu } = useSkillsPorts();
  const { peer } = useRpc();
  const task = useAction();
  const own = useSkillPage(botId, groupId);
  const roleName = useRoleName(botId);
  const [open, setOpen] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [runSkill, setRunSkill] = useState<string>();
  const [removing, setRemoving] = useState<Skill>();
  // Only a saved plan is edited.
  const [editWorkflow, setEditWorkflow] = useState<{ skillId: string }>();
  const workflows = useWorkflows(botId, groupId);
  const workflowBySkill = new Map(workflows.items.map((workflow) => [workflow.skillId, workflow]));
  const reload = own.reload;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new peer or Bot must not keep another Bot's dialogs.
  useEffect(() => {
    setOpen(undefined);
    setPicking(false);
    setEditWorkflow(undefined);
    setRemoving(undefined);
  }, [peer, botId, groupId]);
  // After the reset above, which also runs on mount.
  useEffect(() => {
    if (focusSkillId) setOpen(focusSkillId);
  }, [focusSkillId]);
  useRpcEvent("skills.changed", (event) => {
    if (event.groupId !== groupId || event.botId !== botId || event.reason === "proposed") return;
    // Bursts (team import, the built-in sync, several toggles) refresh once.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      reload();
      workflows.refresh();
    }, 150);
  });
  const disabled = task.busy || !peer || archived;
  const setEnabled = async (skillId: string, enabled: boolean) => {
    if (!peer) return;
    const result = await task.run(
      () => peer.call("skills.setEnabled", { groupId, skillId, enabled }),
      skillError,
    );
    if (result?.id === skillId) own.replace(result);
  };
  const remove = async (skill: Skill) => {
    if (!peer) return;
    const result = await task.run(
      () => peer.call("skills.delete", { groupId, skillId: skill.id, confirmed: true }),
      skillError,
    );
    if (!result) return;
    setRemoving(undefined);
    reload();
  };
  if (open)
    return (
      <SkillDetail
        groupId={groupId}
        skillId={open}
        botId={botId}
        botName={botName}
        send={send}
        back={() => {
          setOpen(undefined);
          reload();
        }}
      />
    );
  // Saved plans are the own skills saved from a passed dynamic plan (provenance recorded
  // only by that save path); every other own skill, old contract skills included, is here.
  const plans = own.rows.filter((skill) => !!skill.savedFromPlan);
  const mine = own.rows.filter((skill) => !skill.savedFromPlan);
  // Unchanged enabled built-ins do not override the member's Bot skills (hasOwn).
  const inherited =
    !!groupId &&
    !own.more &&
    !own.rows.some((skill) => !skill.builtinKey || skill.builtinState?.modified || !skill.enabled);
  const run = allowWorkflowRun ? (skillId: string) => setRunSkill(skillId) : undefined;
  return (
    <>
      <section className={styles.section} aria-label={t("skills.section.mine")}>
        <div className={styles.head}>
          <h2>{t("skills.section.mine")}</h2>
          <PanelMenu
            label={t("skills.add")}
            trigger={t("skills.add")}
            width={180}
            disabled={disabled}
            items={[
              ...(teach ? [{ id: "teach", label: t("skills.teach"), run: teach }] : []),
              { id: "pick", label: t("skills.pick"), run: () => setPicking(true) },
            ]}
          />
        </div>
        {pendingImports}
        {!!mine.length && (
          <div className={styles.list}>
            {mine.map((skill) => (
              <SkillRow
                roleName={roleName}
                key={skill.id}
                skill={skill}
                workflow={workflowBySkill.get(skill.id)}
                disabled={disabled}
                open={() => setOpen(skill.id)}
                remove={() => setRemoving(skill)}
                setEnabled={(enabled) => void setEnabled(skill.id, enabled)}
              />
            ))}
          </div>
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
                onClick={() => void remove(removing)}
              >
                {t("skills.delete")}
              </Button>
              <Button variant="ghost" disabled={task.busy} onClick={() => setRemoving(undefined)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
        <ListFooter
          loading={own.loading}
          error={own.error ? t("skills.failed") : undefined}
          more={own.more}
          retry={own.reload}
          next={() => void own.next()}
        />
        {!own.loading && !own.error && (
          <p className={styles.note}>
            {inherited
              ? t("group.skillsInherited", { bot: botName })
              : !mine.length
                ? t("skills.empty", { bot: botName })
                : t("skills.note", { bot: botName })}
          </p>
        )}
        {task.error && (
          <p role="alert" className={styles.error}>
            {t(task.error)}
          </p>
        )}
      </section>
      <SavedPlans
        rows={plans}
        workflows={workflowBySkill}
        groupId={groupId}
        botName={botName}
        disabled={disabled}
        loading={own.loading}
        failed={workflows.error}
        retry={workflows.refresh}
        open={setOpen}
        run={run}
        edit={(skillId) => setEditWorkflow({ skillId })}
        changed={(skill) => {
          if (skill) own.replace(skill);
          else reload();
          workflows.refresh();
        }}
      />
      {picking && (
        <ConnectionPicker
          botId={botId}
          botName={botName}
          groupId={groupId}
          connections={connections}
          close={() => setPicking(false)}
        />
      )}
      {runSkill && (
        <WorkflowRunDialog
          skillId={runSkill}
          targets={[{ botId, botName, groupId, conversationId }]}
          close={() => setRunSkill(undefined)}
        />
      )}
      {editWorkflow && (
        <WorkflowEditorDialog
          botId={botId}
          groupId={groupId}
          skillId={editWorkflow.skillId}
          close={() => setEditWorkflow(undefined)}
          saved={() => {
            setEditWorkflow(undefined);
            workflows.refresh();
            reload();
          }}
        />
      )}
    </>
  );
}
