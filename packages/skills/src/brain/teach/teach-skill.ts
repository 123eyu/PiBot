import type { Skill, SkillDocumentInput } from "@pibot/skills-contract/full";

/**
 * The skill store "teach it once" saves into. Same shape as T9's `SkillService.create`
 * (`local.skills.create(botId, document, "taught", { enabled })`); a duplicate display name throws
 * `RpcError(invalidParams, "skill_name_exists")`.
 */
export interface TeachSkills {
  create(
    botId: string,
    document: SkillDocumentInput,
    source: "taught",
    options?: { enabled?: boolean },
  ): Promise<Skill>;
}
