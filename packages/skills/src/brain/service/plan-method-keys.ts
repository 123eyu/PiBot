import { skillContract } from "@pibot/brain/kit";
import { RpcError, WORKFLOW_LIST_MAX } from "@pibot/skills-contract/full";
import type { SkillService } from "./skill-service.ts";
import { findWorkflow } from "./skill-workflows.ts";

/** Suggest only keys the owner's actual resolver accepts, not every method in the role pack. */
export async function planMethodKeys(
  service: SkillService,
  botId: string,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  service.activeBot(botId);
  const keys = new Set<string>();
  const checked = new Set<string>();
  for (const record of service.repo.enabledForPrompt(botId)) {
    signal.throwIfAborted();
    if (keys.size >= WORKFLOW_LIST_MAX) break;
    const key = record.builtinKey ?? record.path.split("/").at(-1) ?? "";
    // A correction hint is an identifier list, never arbitrary skill descriptions or file text.
    if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(key) || checked.has(key)) continue;
    checked.add(key);
    try {
      const skill = await findWorkflow(service, botId, key);
      signal.throwIfAborted();
      const contract = skill && skillContract(skill.document).contract;
      if (contract?.deliverables.length && !contract.steps?.length) keys.add(key);
    } catch (error) {
      signal.throwIfAborted();
      // An unreadable installed file is not an available method; other failures remain bugs.
      if (!(error instanceof RpcError) || error.message !== "skill_file_unavailable") throw error;
    }
  }
  return [...keys];
}
