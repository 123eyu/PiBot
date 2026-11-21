import { commitDraftPrompts } from "./prompts/commit-draft.ts";
/** Commit-message drafting for the changes sidebar: one bounded completion, no tools. */
export function commitDraftInstruction(language: "zh" | "en") {
  return commitDraftPrompts.commitDraftInstruction[language];
}

/** Models sometimes wrap the answer; keep only the message and bound its size. */
export function parseCommitDraft(text: string) {
  let value = text.replace(/\r\n?/g, "\n").trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(value);
  if (fenced?.[1]) value = fenced[1].trim();
  value = Array.from(value)
    .filter((char) => char === "\n" || char === "\t" || !/\p{Cc}/u.test(char))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!value) throw new TypeError("Empty commit draft");
  return value.slice(0, 4000);
}
