import path from "node:path";
import type { DeliveryProvenance } from "@pibot/brain/orchestration-kit";
import type { GroupService } from "./group-service.ts";
import { planReplacementChain } from "./group-workflow-lineage.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

/**
 * The plan-side provenance of one step run, handed to the kernel's delivery check. A
 * step's sources are what this plan produced or was given: passed upstream steps (and their
 * declared outputs), every earlier round of the same step (a retry is a new task and run), and the
 * plan's own inputs. Owned here because only orchestration understands the DAG snapshot.
 */
export function stepProvenance(
  service: GroupService,
  runId: string,
  taskId?: string,
): DeliveryProvenance | undefined {
  const run = service.runs.get(runId);
  const id = taskId ?? run?.taskId;
  const spec = id ? service.handoffs.repo.get(id)?.spec : undefined;
  const ref = spec?.workflowStep;
  if (!ref || !run?.groupId) return undefined;
  // A plan on a runner keeps that machine's paths: the desktop's own path rules would turn
  // `C:\…` into a relative path on macOS, and the check then asks the runner for a path outside
  // the workplace (round-1 VM 2026-11-12: every citation check of a runner plan was unavailable).
  const platform = spec.deliveryLocation?.location?.platform;
  const { resolve } = platform ? (platform === "win32" ? path.win32 : path.posix) : path;
  const record = service.workflows.repo.get(ref.workflowRunId);
  if (record?.groupId !== run.groupId) return undefined;
  let workflow: ReturnType<typeof workflowOf>;
  try {
    workflow = workflowOf(record);
  } catch {
    // An unreadable snapshot vouches for nothing; the check still sees the run's own receipts.
    return undefined;
  }
  const definitions = new Map((workflow.contract.steps ?? []).map((step) => [step.id, step]));
  const upstream = new Set<string>();
  const visit = (stepId: string) => {
    if (upstream.has(stepId)) return;
    upstream.add(stepId);
    for (const dependency of definitions.get(stepId)?.dependsOn ?? []) visit(dependency);
  };
  for (const dependency of definitions.get(ref.stepId)?.dependsOn ?? []) visit(dependency);
  const runs: string[] = [];
  const files = workflow.inputs.filter((item) => item.kind === "file").map((item) => item.value);
  const folders = workflow.inputs
    .filter((item) => item.kind === "folder")
    .map((item) => item.value);
  for (const state of service.workflows.repo.steps(record.id)) {
    if (!upstream.has(state.stepId) || state.status !== "passed") continue;
    if (state.executionRunId) runs.push(state.executionRunId);
    for (const item of definitions.get(state.stepId)?.deliverables ?? [])
      files.push(resolve(workflow.folder, item.path));
  }
  // Stable step ids are the correspondence across accepted replacements, never a shared budget.
  const attempts: string[] = [];
  let incomplete = false;
  for (const plan of planReplacementChain(service, record)) {
    if (!workflowOf(plan).contract.steps?.some((step) => step.id === ref.stepId)) break;
    const tasks = service.handoffs.repo.forWorkflowStep(plan.id, ref.stepId, 50);
    incomplete ||= tasks.length === 50;
    for (const taskId of tasks) {
      const task = service.tasks.get(taskId);
      if (task?.groupId !== record.groupId || task.createdByBotId !== record.coordinatorBotId)
        continue;
      const ids = service.runs.taskRunIds(taskId, 50);
      incomplete ||= ids.length === 50;
      for (const id of ids) {
        const attempt = service.runs.get(id);
        if (
          attempt?.groupId === record.groupId &&
          attempt.cycleId === record.cycleId &&
          attempt.botId === task.assigneeBotId &&
          attempt.conversationId === task.threadConversationId
        )
          attempts.push(id);
      }
    }
  }
  return {
    runs,
    attempts,
    incomplete,
    files,
    folders,
    artifactRoot: workflow.folder,
    ...(workflow.delivery ? { workspaceRoot: workflow.delivery.workspaceRoot } : {}),
  };
}
