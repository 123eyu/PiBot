import { useRpc, useT } from "@pibot/renderer-kit";
import type {
  Bot,
  Group,
  SkillContract,
  WorkflowStep,
  WorkflowSummary,
} from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { useEffect, useMemo, useState } from "react";
import { WorkflowDeliveryEditor } from "./WorkflowDeliveryEditor.tsx";
import {
  EditorField,
  EditorSection,
  type InvalidField,
  nextEditorId,
} from "./WorkflowEditorParts.tsx";
import styles from "./workflow.module.css";

export function WorkflowStepEditor({
  groupId,
  contract,
  change,
  invalid,
}: {
  groupId: string;
  contract: SkillContract;
  change(contract: SkillContract): void;
  invalid: InvalidField;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [group, setGroup] = useState<Group>();
  const [bots, setBots] = useState<Bot[]>([]);
  const [workflows, setWorkflows] = useState<Record<string, WorkflowSummary[]>>({});
  const [membersError, setMembersError] = useState(false);
  const [skillsError, setSkillsError] = useState(false);
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly retries the read.
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    setMembersError(false);
    setGroup(undefined);
    setBots([]);
    void Promise.all([
      peer.call("groups.get", { groupId }, { signal: abort.signal }),
      peer.call("bots.list", { limit: 200 }, { signal: abort.signal }),
    ])
      .then(([nextGroup, nextBots]) => {
        if (!abort.signal.aborted) {
          setGroup(nextGroup);
          setBots(nextBots);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setMembersError(true);
      });
    return () => abort.abort();
  }, [peer, groupId, reload]);
  const members = useMemo(
    () => group?.members.flatMap((member) => bots.filter((bot) => bot.id === member.botId)) ?? [],
    [group, bots],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly retries member skills.
  useEffect(() => {
    if (!peer || !members.length) {
      setWorkflows({});
      return;
    }
    const abort = new AbortController();
    setSkillsError(false);
    setWorkflows({});
    void Promise.all(
      members.map(
        async (bot) =>
          [
            bot.id,
            (
              await peer.call(
                "skills.workflows",
                { botId: bot.id, groupId },
                { signal: abort.signal },
              )
            ).items.filter((item) => item.enabled && item.contract && !item.contract.steps?.length),
          ] as const,
      ),
    )
      .then((items) => {
        if (!abort.signal.aborted) setWorkflows(Object.fromEntries(items));
      })
      .catch(() => {
        if (!abort.signal.aborted) setSkillsError(true);
      });
    return () => abort.abort();
  }, [peer, groupId, members, reload]);
  const roleCounts = new Map<string, number>();
  for (const bot of members)
    if (bot.role?.id) roleCounts.set(bot.role.id, (roleCounts.get(bot.role.id) ?? 0) + 1);
  const roles = [...roleCounts].filter(([, count]) => count === 1).map(([role]) => role);
  const steps = contract.steps ?? [];
  const firstMember = members[0];
  const update = (index: number, step: WorkflowStep) =>
    change({
      ...contract,
      steps: steps.map((item, itemIndex) => (itemIndex === index ? step : item)),
    });
  return (
    <EditorSection
      title={t("workflows.editor.steps")}
      add={
        firstMember && steps.length < 20
          ? () =>
              change({
                ...contract,
                steps: [
                  ...steps,
                  {
                    id: nextEditorId(
                      "step",
                      steps.map((step) => step.id),
                    ),
                    title: "",
                    owner: { botId: firstMember.id },
                    task: "",
                    dependsOn: [],
                    deliverables: [],
                    acceptance: [],
                  },
                ],
              })
          : undefined
      }
    >
      {(membersError || skillsError) && (
        <div role="alert">
          <p>
            {t(
              membersError
                ? "workflows.editor.membersLoadError"
                : "workflows.editor.skillsLoadError",
            )}
          </p>
          <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {!!steps.length && (
        <section className={styles.stepGraph} aria-label={t("workflows.editor.dependencyGraph")}>
          {steps.map((step) => (
            <span key={step.id}>
              {step.dependsOn.length ? `${step.dependsOn.join(" + ")} → ` : ""}
              {step.title || step.id}
            </span>
          ))}
        </section>
      )}
      {steps.map((step, index) => {
        const owner = "botId" in step.owner ? `bot:${step.owner.botId}` : `role:${step.owner.role}`;
        const ownerRole = "role" in step.owner ? step.owner.role : undefined;
        const taskSkillId = typeof step.task === "string" ? "" : step.task.skillId;
        const ownerBotId =
          "botId" in step.owner
            ? step.owner.botId
            : members.find((bot) => bot.role?.id === ownerRole)?.id;
        const ownerWorkflows = ownerBotId ? (workflows[ownerBotId] ?? []) : [];
        return (
          <section className={styles.stepCard} key={step.id}>
            <div className={styles.sectionTitle}>
              <b>{step.title || `${t("workflows.editor.step")} ${index + 1}`}</b>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  change({ ...contract, steps: steps.filter((_, item) => item !== index) })
                }
              >
                {t("workflows.editor.remove")}
              </Button>
            </div>
            <EditorField
              label={t("workflows.editor.stepTitle")}
              invalid={invalid(`contract.steps.${index}.title`)}
            >
              <input
                value={step.title}
                maxLength={200}
                onChange={(event) => update(index, { ...step, title: event.currentTarget.value })}
              />
            </EditorField>
            <EditorField
              label={t("workflows.editor.owner")}
              invalid={invalid(`contract.steps.${index}.owner`)}
            >
              <select
                value={owner}
                onChange={(event) => {
                  const [kind, value] = event.currentTarget.value.split(":", 2);
                  update(index, {
                    ...step,
                    owner: kind === "role" ? { role: value ?? "" } : { botId: value ?? "" },
                  });
                }}
              >
                {members.map((bot) => (
                  <option key={bot.id} value={`bot:${bot.id}`}>
                    {bot.name}
                  </option>
                ))}
                {roles.map((role) => (
                  <option key={role} value={`role:${role}`}>
                    {t("workflows.editor.role", { role })}
                  </option>
                ))}
              </select>
            </EditorField>
            <EditorField
              label={t("workflows.editor.task")}
              invalid={invalid(`contract.steps.${index}.task`)}
            >
              {typeof step.task === "string" ? (
                <textarea
                  rows={3}
                  value={step.task}
                  placeholder={t("workflows.editor.taskHint")}
                  onChange={(event) => update(index, { ...step, task: event.currentTarget.value })}
                />
              ) : (
                // A step that already runs a contract skill keeps it; no new pick.
                <select value={step.task.skillId} disabled>
                  <option value={taskSkillId}>
                    {ownerWorkflows.find((workflow) => workflow.skillId === taskSkillId)?.name ??
                      taskSkillId}
                  </option>
                </select>
              )}
            </EditorField>
            <EditorField
              label={t("workflows.editor.dependsOn")}
              invalid={invalid(`contract.steps.${index}.dependsOn`)}
            >
              <select
                multiple
                value={step.dependsOn}
                onChange={(event) =>
                  update(index, {
                    ...step,
                    dependsOn: [...event.currentTarget.selectedOptions].map(
                      (option) => option.value,
                    ),
                  })
                }
              >
                {steps
                  .filter((candidate) => candidate.id !== step.id)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title || candidate.id}
                    </option>
                  ))}
              </select>
            </EditorField>
            <WorkflowDeliveryEditor
              contract={{
                ...contract,
                deliverables: step.deliverables,
                acceptance: step.acceptance,
              }}
              change={(next) =>
                update(index, {
                  ...step,
                  deliverables: next.deliverables,
                  acceptance: next.acceptance,
                })
              }
              invalid={(path) => invalid(path.replace("contract.", `contract.steps.${index}.`))}
            />
          </section>
        );
      })}
    </EditorSection>
  );
}
