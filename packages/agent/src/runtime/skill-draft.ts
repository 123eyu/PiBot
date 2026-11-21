import { skillDraftPrompts } from "./prompts/skill-draft.ts";
/** "Teach it once": turning reviewed browser steps into a skill draft; one completion, no tools. */
export function skillDraftInstruction(language: "zh" | "en") {
  return language === "zh"
    ? [
        skillDraftPrompts.skillDraftInstruction.zh.item1,
        skillDraftPrompts.skillDraftInstruction.zh.item2,
        skillDraftPrompts.skillDraftInstruction.zh.item3,
        skillDraftPrompts.skillDraftInstruction.zh.item4,
        skillDraftPrompts.skillDraftInstruction.zh.item5,
      ].join("\n")
    : [
        skillDraftPrompts.skillDraftInstruction.en.item1,
        skillDraftPrompts.skillDraftInstruction.en.item2,
        skillDraftPrompts.skillDraftInstruction.en.item3,
        skillDraftPrompts.skillDraftInstruction.en.item4,
        skillDraftPrompts.skillDraftInstruction.en.item5,
      ].join("\n");
}

/** Models sometimes wrap JSON in fences or prose; the object itself is checked by brain. */
export function parseSkillDraft(text: string): unknown {
  const value = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(value);
  const body = fenced?.[1] ?? value;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new TypeError("No skill draft");
  return JSON.parse(body.slice(start, end + 1));
}
