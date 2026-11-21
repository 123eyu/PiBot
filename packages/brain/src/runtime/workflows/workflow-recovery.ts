import type { RunWorkflow } from "@pibot/storage";
import { skillContract } from "../../resources/packages/skill-format.ts";
import type { SkillsPort } from "../tools/skills/port.ts";
import type { WorkflowRun } from "./workflow-prepare.ts";

/**
 * What a workflow run keeps beside its run row (`run_recovery`), so a restart or a resume
 * runs it as the same workflow. Identity only: the body is read again from the skill file.
 */
export function workflowIdentity(run: WorkflowRun): RunWorkflow {
  return {
    skillId: run.skillId,
    version: run.version,
    params: run.params,
    inputs: run.inputs,
    ...(run.folder ? { folder: run.folder } : {}),
    ...(run.previous ? { previous: run.previous } : {}),
    ...(run.previousFromLedger ? { previousFromLedger: true } : {}),
    budget: run.contract.budget ?? null,
  };
}

/**
 * The workflow run a recovered or resumed run executes: the current skill body and contract,
 * with the persisted parameters, inputs, folders and budget. Pre-checks passed when the run was
 * first sent and are not repeated (as for a hand-off sign-off). Undefined when the skill is gone,
 * no longer a valid contract skill, or has another version: the caller refuses instead of
 * running a different workflow than the one the user started.
 */
export async function restoreWorkflow(
  skills: SkillsPort | undefined,
  botId: string,
  groupId: string | undefined,
  identity: RunWorkflow,
): Promise<WorkflowRun | undefined> {
  if (!skills) return undefined;
  let skill: Awaited<ReturnType<SkillsPort["workflowSkill"]>>;
  try {
    skill = await skills.workflowSkill(botId, identity.skillId, groupId);
  } catch {
    // A removed skill or an archived Bot: the persisted identity no longer names a workflow.
    return undefined;
  }
  const { contract } = skillContract(skill.document);
  if (!contract || (skill.document.version ?? null) !== identity.version) return undefined;
  const { budget: _current, ...rest } = contract;
  return {
    skillId: skill.id,
    name: skill.document.name,
    version: identity.version,
    body: skill.document.body,
    ...(skill.provenance ? { provenance: skill.provenance } : {}),
    ...(skill.baseDir ? { baseDir: skill.baseDir } : {}),
    // Same version means the same contract; the stored budget still wins so it can never grow.
    contract: identity.budget ? { ...rest, budget: identity.budget } : rest,
    params: identity.params,
    inputs: identity.inputs,
    ...(identity.folder ? { folder: identity.folder } : {}),
    ...(identity.previous ? { previous: identity.previous } : {}),
    ...(identity.previousFromLedger ? { previousFromLedger: true } : {}),
  };
}
