import type { ToolJournalEntry } from "@pibot/storage";

/** Calls named in the note; the rest are counted. The receipt lists them for the user. */
export const RESUME_NOTE_CALLS = 12;

/**
 * Pi Bot's trusted runtime note for a run the user resumed (`<runResume>` in the state
 * message). Facts from the execution journal only: tool names and effect classes of the calls
 * with an unknown outcome, never arguments or results. Changing it changes what models see.
 */
export function resumeNote(
  uncertain: readonly ToolJournalEntry[],
  total: number,
  cause: "restart" | "approval" = "restart",
): string {
  const listed = uncertain
    .slice(0, RESUME_NOTE_CALLS)
    .map((entry) => `${entry.tool} (${entry.effectClass})`);
  const more = Math.max(0, total - listed.length);
  const calls = listed.length
    ? {
        en: `Calls whose outcome is unknown: ${listed.join(", ")}${more ? `, and ${more} more` : ""}.`,
        zh: `结果不明的调用：${listed.join("、")}${more ? `，另有 ${more} 个` : ""}。`,
      }
    : { en: "No call was left with an unknown outcome.", zh: "没有结果不明的调用。" };
  const opening =
    cause === "approval"
      ? {
          en: "The previous run paused before dispatch because an approval timed out. The user has now answered the card and asked to continue.",
          zh: "上一次运行因审批到期在执行前暂停；用户现在已回答卡片，要求继续。",
        }
      : {
          en: "The previous run in this conversation was interrupted (Pi Bot restarted while it was working) and the user asked to continue it.",
          zh: "上一次运行因 Pi Bot 重启而中断，用户要求继续。",
        };
  return [
    `${opening.en} Pi Bot's execution journal answers for the calls it already made: a completed call is not executed again (you get its recorded result), and an identical call whose outcome is unknown is refused. ${calls.en} Before relying on them, check what they actually did with read-only tools (read_file, list_dir, find_files, search_text). If one did not take effect and is still needed, tell the user: Pi Bot does not repeat it within this continuation, and the user can confirm it in a new message.`,
    `${opening.zh}Pi Bot 的执行登记会处理已经发出的调用：已完成的不再执行（交还登记的结果），结果不明的相同调用会被拒绝。${calls.zh}继续之前先用只读工具（read_file、list_dir、find_files、search_text）核对它们实际做了什么。如果某个调用没有生效且仍然需要，告诉用户：本次继续里 Pi Bot 不会重复它，用户可以在新消息里确认。`,
  ].join("\n");
}
