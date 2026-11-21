import type { Skill } from "@earendil-works/pi-coding-agent";
import { SKILL_TOOL_MAPPING } from "@pibot/protocol-base";
import type { SkillPromptEntry } from "../core/types.ts";
import { REFERENCE_MARKER, STATE_MARKER } from "../extensions/volatile-state.ts";
import { skillsPromptPrompts } from "./prompts/skills-prompt.ts";

type Format = (skills: Skill[], fileReadTool?: "read" | "bash" | "indirect") => string;

const OWN = { zh: "（自有技能）", en: "(own skill) " };
const TOOL_MAPPING = Object.entries(SKILL_TOOL_MAPPING)
  .map(([source, target]) => `${source} → ${target}`)
  .join("; ");
const COMPATIBILITY = {
  zh: skillsPromptPrompts.COMPATIBILITY.zh({ TOOL_MAPPING }),
  en: skillsPromptPrompts.COMPATIBILITY.en({ TOOL_MAPPING }),
};

/**
 * These sentences never state the current status, so preparing a runtime later
 * does not invalidate the cached prefix. Which environment is ready belongs in the session tail.
 */
const RUNTIME = {
  zh: skillsPromptPrompts.RUNTIME.zh,
  en: skillsPromptPrompts.RUNTIME.en,
};

/**
 * A fixed sentence pair, so a document task's default path and an imported
 * skill's place in it do not change between runs and keep the cached prompt prefix intact. It
 * states the order only, not which skills or runtimes exist here.
 */
const DOCUMENTS = {
  zh: skillsPromptPrompts.DOCUMENTS.zh,
  en: skillsPromptPrompts.DOCUMENTS.en,
};

function escapeXml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll(STATE_MARKER, STATE_MARKER.replace("[", "［"))
    .replaceAll(REFERENCE_MARKER, REFERENCE_MARKER.replace("[", "［"));
}

/**
 * SEC: skills copied from a plugin, a skill file / archive / folder or a team file were authored
 * outside this app. Their names and descriptions stay listed (the model needs them to pick one),
 * but in a fenced block of their own that says what they are, so a crafted description cannot
 * read as part of Pi Bot's instructions.
 */
function importedBlock(entries: readonly SkillPromptEntry[], language: "zh" | "en") {
  const intro = skillsPromptPrompts.importedBlock.intro[language];
  const skills = entries.map(
    (entry) =>
      `  <skill>\n    <name>${escapeXml(entry.name)}</name>\n    <description>${escapeXml(entry.description)}</description>\n    <location>${escapeXml(entry.filePath)}</location>\n  </skill>`,
  );
  return `\n\n<imported_skills untrusted="true">\n${intro}\n${skills.join("\n")}\n</imported_skills>`;
}

/**
 * pi 1.1.0 renders its skill list only when a tool named `read`/`bash` is enabled, so Pi Bot
 * keeps `getSkills()` empty and appends pi's own formatter output with `read_file` guidance.
 * Bodies are never inlined: the model reads SKILL.md through the policy gate when it needs one.
 * Built-in and own skills use pi's list (own ones labelled); imported ones get their own fence.
 */
export function skillsPrompt(
  format: Format,
  entries: readonly SkillPromptEntry[],
  language: "zh" | "en",
): string {
  if (!entries.length) return "";
  const listed = format(
    entries
      .filter((entry) => entry.provenance !== "imported")
      .map((entry) => ({
        name: entry.name,
        description: `${entry.provenance === "own" ? OWN[language] : ""}${entry.description}`,
        filePath: entry.filePath,
        baseDir: entry.baseDir,
        sourceInfo: { path: entry.filePath, source: "pibot", scope: "user", origin: "top-level" },
        disableModelInvocation: false,
      })),
    "indirect",
  );
  const imported = entries.filter((entry) => entry.provenance === "imported");
  const fenced = imported.length ? importedBlock(imported, language) : "";
  if (!listed && !fenced) return "";
  const rule = skillsPromptPrompts.skillsPrompt.rule[language];
  const scripts = skillsPromptPrompts.skillsPrompt.scripts[language];
  return `${listed}${fenced}\n${rule}\n${scripts}\n${RUNTIME[language]}\n${DOCUMENTS[language]}\n${COMPATIBILITY[language]}`;
}
