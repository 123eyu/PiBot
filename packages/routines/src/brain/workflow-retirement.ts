import { abortable, resolvePersonaLanguage } from "@pibot/brain/kit";
import {
  type Routine,
  SkillContractSchema,
  type WorkflowBinding,
  type WorkflowBudget,
} from "@pibot/protocol";
import { SettingsRepo, transaction } from "@pibot/storage";
import { RoutineWorkflowRetirementsRepo, type WorkflowRetirement } from "../store/index.ts";
import type { RoutineService } from "./service.ts";

/** The routines table keeps instructions within 1..4000 characters. */
const INSTRUCTIONS_MAX = 4000;

/**
 * The request a retired workflow binding becomes: what to do, the values the user had filled in
 * and the user's own notes. Program text in the user's language; the Bot plans from it each run
 * and may consult the method of that name in its skills.
 */
export function retiredWorkflowRequest(
  name: string,
  binding: WorkflowBinding,
  notes: string,
  language: "zh" | "en",
): string {
  const zh = language === "zh";
  const lines = [
    zh
      ? `完成例行工作「${name}」：每次先按下面的输入规划，再执行（可参考同名方法）。`
      : `Do the routine work "${name}": each time, plan from the inputs below first, then carry it out (the method of that name may serve as a reference).`,
  ];
  const params = Object.entries(binding.params).filter(([, value]) => value.trim());
  if (params.length)
    lines.push(
      `${zh ? "参数：" : "Parameters: "}${params.map(([key, value]) => `${key}=${value}`).join(zh ? "；" : "; ")}`,
    );
  const inputs = Object.entries(binding.inputs).filter(([, value]) => value.trim());
  if (inputs.length) {
    lines.push(zh ? "输入：" : "Inputs:");
    for (const [key, value] of inputs) lines.push(`- ${key}${zh ? "：" : ": "}${value}`);
  }
  if (notes.trim()) lines.push("", zh ? "备注：" : "Notes:", notes.trim());
  return lines.join("\n");
}

/**
 * Migration 0102: settles the queued routines once, before the first schedule tick.
 * A saved plan's binding is kept; any other binding becomes request text plus the contract
 * budget (`routines.budget`), with inputs, artifact folder, triggers and duration unchanged.
 * Fail-closed per row: a routine that cannot be settled is disabled with its binding intact and
 * the reason audited; a version conflict (the user is editing it right now) waits for next start.
 */
export async function retireRoutineWorkflows(service: RoutineService, signal: AbortSignal) {
  const repo = new RoutineWorkflowRetirementsRepo(service.deps.db);
  const rows = repo.pending();
  if (!rows.length) return;
  const language = resolvePersonaLanguage(
    new SettingsRepo(service.deps.db).get().language,
    Intl.DateTimeFormat().resolvedOptions().locale,
  );
  for (const row of rows) {
    signal.throwIfAborted();
    await retireOne(service, repo, row, language, signal);
  }
  service.changed();
}

async function retireOne(
  service: RoutineService,
  repo: RoutineWorkflowRetirementsRepo,
  row: WorkflowRetirement,
  language: "zh" | "en",
  signal: AbortSignal,
) {
  const routine = service.repo.get(row.routineId);
  if (!routine || routine.deletedAt || routine.workflow?.skillId !== row.skillId) {
    repo.settle(row.routineId, "skipped");
    return;
  }
  if (row.kind === "saved_plan") {
    transaction(service.deps.db, () => {
      repo.settle(row.routineId, "kept");
      service.audit("routine.updated", routine, {
        actor: "system",
        reasonCode: "workflow_saved_plan",
      });
    });
    return;
  }
  let request: { text: string; budget: WorkflowBudget | null };
  try {
    request = await requestOf(service, routine, routine.workflow, language, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    fail(service, repo, routine, "workflow_unavailable");
    return;
  }
  try {
    transaction(service.deps.db, () => {
      const updated = service.repo.update(
        routine.id,
        { workflow: null, instructions: request.text },
        routine.version,
      );
      repo.setBudget(routine.id, request.budget);
      repo.settle(routine.id, "planned");
      service.audit("routine.updated", updated, {
        actor: "system",
        reasonCode: "workflow_retired",
      });
    });
  } catch (error) {
    // Edited at this moment: the row stays pending and is settled at the next start.
    if (error instanceof TypeError && error.message === "Routine version conflict") return;
    fail(service, repo, routine, "workflow_retire_failed");
  }
}

async function requestOf(
  service: RoutineService,
  routine: Routine,
  binding: WorkflowBinding,
  language: "zh" | "en",
  signal: AbortSignal,
) {
  const skills = service.deps.local.skills;
  if (!skills) throw new Error("skills_unavailable");
  const skill = await abortable(
    skills.workflowSkill(routine.botId, binding.skillId),
    AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  );
  const contract = skill.document.contract
    ? SkillContractSchema.safeParse(JSON.parse(skill.document.contract))
    : undefined;
  const budget = contract?.success ? (contract.data.budget ?? null) : null;
  const text = retiredWorkflowRequest(skill.document.name, binding, routine.instructions, language);
  if (text.length > INSTRUCTIONS_MAX) throw new Error("routine_request_too_long");
  return { text, budget };
}

/** Disabled, not deleted: the old binding still runs if the user turns it back on. */
function fail(
  service: RoutineService,
  repo: RoutineWorkflowRetirementsRepo,
  routine: Routine,
  reason: string,
) {
  let logged = reason;
  try {
    transaction(service.deps.db, () => {
      const current = service.repo.get(routine.id);
      if (current?.enabled) service.repo.update(routine.id, { enabled: false }, current.version);
      repo.settle(routine.id, "failed", reason);
      service.audit("routine.paused", current ?? routine, { actor: "system", reasonCode: reason });
    });
  } catch {
    // Still pending with its binding, which the runtime keeps running; retried at next start.
    logged = `${reason}_deferred`;
  }
  service.deps.logger.warn(
    JSON.stringify({
      module: "routines",
      event: "workflow_retire_failed",
      routineId: routine.id,
      reason: logged,
    }),
  );
}
