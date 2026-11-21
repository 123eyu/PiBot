import type { SkillDocumentInput, SkillDraft } from "@pibot/skills-contract/full";

/** "Needs" section kept with the skill, so the Bot (and the user reading it) knows what it touches. */
function needs(draft: SkillDraft, language: "zh" | "en") {
  const { domains, writePaths, sendTo } = draft.permissions;
  const zh = language === "zh";
  const lines = [
    domains.length ? `- ${zh ? "网站" : "Sites"}: ${domains.join(", ")}` : "",
    writePaths.length ? `- ${zh ? "写文件" : "Writes files to"}: ${writePaths.join(", ")}` : "",
    sendTo.length ? `- ${zh ? "对外发送" : "Sends to"}: ${sendTo.join(", ")}` : "",
  ].filter(Boolean);
  return lines.length
    ? `\n\n## ${zh ? "需要的权限" : "Permissions needed"}\n\n${lines.join("\n")}`
    : "";
}

/** The skill as stored: the edited steps plus what it needs; parameters stay structured. */
export function skillDocument(draft: SkillDraft, language: "zh" | "en"): SkillDocumentInput {
  return {
    name: draft.name,
    description: draft.description,
    body: `${draft.body}${needs(draft, language)}`,
    params: draft.params,
  };
}

/**
 * Markdown headings read as stray "##" in the user's bubble (user messages are shown as plain
 * text); the trial message is plain text, so headings become their words.
 */
const plainHeadings = (text: string) =>
  text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/gm, "$1");

/** One trial in a new topic: the unsaved skill with its default values, run like a chat message. */
export function trialMessage(draft: SkillDraft, language: "zh" | "en") {
  const zh = language === "zh";
  const values = draft.params.map(
    (p) =>
      `- ${p.name}: ${p.default?.trim() || (zh ? "（没有默认值，先问我）" : "(no default; ask me first)")}`,
  );
  return [
    // Saving happens on the teach page, not in chat: offering to save here asks for something
    // the Bot cannot do and the user cannot answer in this topic.
    zh
      ? `试运行一次技能「${draft.name}」（还没保存）。请按下面的步骤做一遍；需要登录时请我接管登录。做完只汇报这次试运行的结果：做成了没有、每一步怎么样、哪里出了问题；不要问要不要保存或存成技能，保存由我在别处决定。`
      : `Trial run of the skill "${draft.name}" (not saved yet). Please follow the steps below once; if a sign-in is needed, ask me to take over and sign in. When done, only report how this trial went: whether it worked, how each step went and what went wrong; do not offer or ask to save it as a skill, I decide that elsewhere.`,
    ...(values.length ? ["", zh ? "这次的参数：" : "Values for this run:", ...values] : []),
    "",
    plainHeadings(`${draft.body}${needs(draft, language)}`),
  ]
    .join("\n")
    .trim();
}
