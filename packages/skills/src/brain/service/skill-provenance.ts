import type { SkillProvenance } from "@pibot/agent";
import type { SkillRecord } from "../../store/skills/skills.ts";

/**
 * SEC: where a stored skill's text came from, for the prompt's skill index and a workflow run's
 * reference message. A team file counts as imported: it may come from anyone, and its skills
 * were written outside this app just like a plugin's or a picked file's.
 */
export function skillProvenance(
  record: Pick<SkillRecord, "builtinKey" | "savedFromPlan" | "source">,
): SkillProvenance {
  if (record.builtinKey) return "builtin";
  if (record.savedFromPlan) return "own";
  return record.source === "imported" || record.source === "team" ? "imported" : "own";
}
