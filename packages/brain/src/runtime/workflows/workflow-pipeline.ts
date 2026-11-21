import type { HandoffPipeline } from "@pibot/protocol-base";
import { skillContract } from "../../resources/packages/skill-format.ts";
import type { WorkflowFolder } from "./workflow-folder.ts";
import type { WorkflowRun, WorkflowSkill } from "./workflow-prepare.ts";

/**
 * What a group hand-off keeps of the coordinator's workflow run (no body: the skill file
 * is read again for the sign-off run, so an edited skill is never run from a stale copy).
 */
export function workflowPipeline(run: WorkflowRun, place: WorkflowFolder): HandoffPipeline {
  return {
    skillId: run.skillId,
    name: run.name.slice(0, 200),
    folder: place.folder,
    params: run.params.slice(0, 20),
    inputs: run.inputs.slice(0, 12),
    ...(place.previous
      ? {
          previous: {
            folder: place.previous.folder,
            files: place.previous.files.slice(0, 20),
          },
        }
      : {}),
  };
}

/**
 * The coordinator's sign-off run continues the same workflow: same folder, inputs, parameters
 * and previous period, current skill body and contract. Pre-checks passed when the workflow
 * started and are not repeated. Undefined when the skill no longer carries a valid contract.
 */
export function pipelineWorkflow(
  skill: WorkflowSkill,
  pipeline: HandoffPipeline,
): WorkflowRun | undefined {
  const { contract } = skillContract(skill.document);
  if (!contract) return undefined;
  return {
    skillId: skill.id,
    name: skill.document.name,
    version: skill.document.version ?? null,
    body: skill.document.body,
    ...(skill.baseDir ? { baseDir: skill.baseDir } : {}),
    contract,
    params: pipeline.params,
    inputs: pipeline.inputs,
    folder: pipeline.folder,
    ...(pipeline.previous ? { previous: pipeline.previous } : {}),
  };
}
