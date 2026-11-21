export const SKILL_COMMAND_TEMPLATES = {
  zh: "请使用技能「{name}」处理下面的任务：\n",
  en: "Use the skill “{name}” for the following task:\n",
} as const;

/** Matches the composer's explicit selection, never arbitrary mentions in reference material. */
export function selectedSkillName(text: string): string | undefined {
  for (const template of Object.values(SKILL_COMMAND_TEMPLATES)) {
    const [before, after] = template.split("{name}") as [string, string];
    if (!text.startsWith(before)) continue;
    const end = text.indexOf(after, before.length);
    if (end > before.length) return text.slice(before.length, end);
  }
}
