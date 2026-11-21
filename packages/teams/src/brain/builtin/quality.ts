import { createHash } from "node:crypto";
import { skillContract } from "@pibot/brain/kit";
import type { WorkflowWarning } from "@pibot/protocol";
import type { ResolvedTeam } from "../teams/team-archive.ts";
import type { BuiltinContent } from "./load.ts";
import { researchMethodKeys } from "./methods.ts";

const engineering = new Set([
  "backend-dev",
  "frontend-dev",
  "fullstack-dev",
  "devops",
  "code-reviewer",
  "qa-engineer",
]);
const languages = ["zh", "en"] as const;
const lines = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
const normalized = (line: string) =>
  line
    .replace(/^[-*]\s*/u, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();

/** Validate both localized templates: English must not silently escape the Chinese checks. */
export function packIssues(zh: ResolvedTeam, en: ResolvedTeam): string[] {
  const issues: string[] = [];
  for (const [language, resolved] of [
    ["zh", zh],
    ["en", en],
  ] as const) {
    const { template } = resolved;
    for (const [index, bot] of template.bots.entries()) {
      const label = `${bot.ref}/${language}`;
      const norms = lines(bot.norms ?? "");
      if (norms.length < 10 || norms.length > 15 || norms.some((line) => !line.startsWith("- ")))
        issues.push(`${label}: norms must have 10-15 bullet lines`);
      if (new Set(norms.map(normalized)).size !== norms.length)
        issues.push(`${label}: duplicate norm`);
      if (lines(bot.systemPrompt).length > 8) issues.push(`${label}: persona exceeds 8 lines`);
      const skills = resolved.skills[index] ?? [];
      // App-owned research methods carry contracts independently of ordinary role skills.
      const roleSkills = skills.filter(
        (skill) =>
          !(
            (bot.ref === "researcher" || bot.ref === "data-analyst") &&
            researchMethodKeys.includes(skill.folder)
          ),
      );
      const workflowSkills = roleSkills.filter(
        (skill) => skill.document.contract !== undefined,
      ).length;
      const ordinarySkills = roleSkills.length - workflowSkills;
      // The tutor has two study skills of its own (interview drill and revision plan), so only
      // the researcher is exempt from the ordinary-skill minimum. The data-analyst's
      // four skills are all app-owned methods now, so it has no ordinary skill to count either.
      const methodOnly = bot.ref === "researcher" || bot.ref === "data-analyst";
      // Keep the presentation review loop and classroom animation in separate on-demand skills.
      const ordinaryLimit =
        bot.ref === "presentation-designer" ? 5 : bot.ref === "personal-assistant" ? 4 : 3;
      if (
        bot.ref === "general-assistant"
          ? skills.length !== 0
          : (!methodOnly && ordinarySkills < 2) ||
            ordinarySkills > ordinaryLimit ||
            workflowSkills > 1
      )
        issues.push(
          `${label}: expected 2-${ordinaryLimit} ordinary skills plus at most one workflow skill`,
        );
      const thinking =
        bot.category === "image" ? "off" : engineering.has(bot.ref) ? "medium" : "low";
      if (bot.thinkingLevel !== thinking) issues.push(`${label}: expected thinking ${thinking}`);
    }
    for (const group of template.groups) {
      const label = `${group.template?.id ?? "group"}/${language}`;
      if (Array.from(group.announcement).length > 500)
        issues.push(`${label}: announcement exceeds 500 characters`);
      if (group.members.length < 2 || group.members.length > 6)
        issues.push(`${label}: expected 2-6 members`);
      if (group.members[0] !== group.coordinator)
        issues.push(`${label}: coordinator must be first`);
      const coordinator = template.bots.find((bot) => bot.ref === group.coordinator);
      if (!coordinator || coordinator.category === "image")
        issues.push(`${label}: coordinator must be a text Bot`);
    }
  }
  const english = new Map(en.template.bots.map((bot) => [bot.ref, bot]));
  for (const bot of zh.template.bots) {
    const other = english.get(bot.ref);
    if (!other || lines(bot.norms ?? "").length !== lines(other.norms ?? "").length)
      issues.push(`${bot.ref}: norm counts differ between languages`);
  }
  return issues;
}

/** Contract findings of every canonical role skill, per language (codes only, no text). */
function skillFindings(content: BuiltinContent): { where: string; warning: WorkflowWarning }[] {
  const findings: { where: string; warning: WorkflowWarning }[] = [];
  for (const [id, pack] of content.roles)
    for (const language of languages)
      for (const skill of pack[language].skills[0] ?? [])
        for (const warning of skillContract(skill.document).warnings)
          findings.push({ where: `${id}/${skill.folder}/${language}`, warning });
  return findings;
}

/** Compare canonical roles only; group copies are already compared by consistencyIssues. */
export function contentIssues(content: BuiltinContent): string[] {
  const issues: string[] = skillFindings(content)
    .filter((finding) => finding.warning === "contract_invalid")
    .map((finding) => `${finding.where}: pibot-contract is invalid`);
  const avatars = new Map<string, string>([["blob:violet", "Pi"]]);
  const skills = new Map<string, { role: string; hash: string }>();
  for (const [id, pack] of content.roles) {
    const bot = pack.zh.template.bots[0];
    if (!bot) continue;
    const avatar = `${bot.avatarShape}:${bot.avatarColor}`;
    const previous = avatars.get(avatar);
    if (previous) issues.push(`${id}: avatar duplicates ${previous}`);
    else avatars.set(avatar, id);
    for (const skill of bot.skills ?? []) {
      if (!("folder" in skill) || !skill.folder) continue;
      const prefix = `skills/${id}/${skill.folder}/`;
      const files = pack.entries
        .filter((entry) => entry.path.startsWith(prefix))
        .sort((a, b) => a.path.localeCompare(b.path));
      const hash = createHash("sha256");
      // Length framing prevents distinct path/content boundaries hashing as the same byte stream.
      for (const file of files) {
        const path = file.path.slice(prefix.length);
        hash.update(JSON.stringify([path, file.data.length]));
        hash.update(file.data);
      }
      const value = hash.digest("hex");
      const existing = skills.get(skill.folder);
      if (!files.length) issues.push(`${id}/${skill.folder}: missing skill files`);
      else if (existing && existing.hash !== value)
        issues.push(`${skill.folder}: shared skill differs between ${existing.role} and ${id}`);
      else if (!existing) skills.set(skill.folder, { role: id, hash: value });
    }
  }
  return issues;
}

/** Warn about copied boilerplate without logging prompt text or counting group copies as roles. */
export function contentWarnings(content: BuiltinContent): string[] {
  // Long bodies and many stop rules are warnings, not errors.
  const warnings: string[] = skillFindings(content)
    .filter((finding) => finding.warning !== "contract_invalid")
    .map((finding) => `skill ${finding.where}: ${finding.warning}`);
  // A missing marker stays loadable for private experimentation, but must be visible when a
  // contract workflow is proposed for the built-in library.
  for (const [id, pack] of content.roles)
    for (const language of languages)
      for (const skill of pack[language].skills[0] ?? [])
        if (skill.document.contract !== undefined && skill.document.verified === undefined)
          warnings.push(
            `skill ${id}/${skill.folder}/${language}: missing pibot-verified; 未验证的工作流应留作私有模板`,
          );
  for (const language of languages) {
    const uses = new Map<string, Set<string>>();
    for (const [id, pack] of content.roles)
      for (const line of lines(pack[language].template.bots[0]?.norms ?? "")) {
        const hash = createHash("sha256").update(normalized(line)).digest("hex").slice(0, 12);
        const roles = uses.get(hash) ?? new Set<string>();
        roles.add(id);
        uses.set(hash, roles);
      }
    for (const [hash, roles] of uses)
      if (roles.size >= 5)
        warnings.push(`repeated_norm language=${language} hash=${hash} roles=${roles.size}`);
  }
  return warnings;
}
