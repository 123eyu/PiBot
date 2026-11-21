import type { AgentErrorCode, GroupContextPart } from "../core/types.ts";

/** Why the context hook stopped a run before any request (never a user stop). */
export type PromptFailure = Extract<AgentErrorCode, "context_too_large" | "context_unavailable">;

/** Even the smallest reference header (or the current turn) does not fit the model's window. */
export class PromptBudgetError extends Error {
  constructor() {
    super("context_too_large");
    this.name = "PromptBudgetError";
  }
}

// Shown to the model, not the user; read_messages is the only tool that reaches task threads.
const omittedNote = (count: number) =>
  `${count} more task(s) not listed to fit the context window; look them up with read_messages (mode=list includes task threads). / 还有 ${count} 个任务没列出（按上下文窗口裁剪），可用 read_messages 工具查询（mode=list 会列出任务线程）。`;

/**
 * The group reference header within `limit` UTF-8 bytes. Task snapshots are dropped
 * first, least relevant (lowest rank) first, and counted in one "N not listed" line; then every
 * part with a compact form uses it. `information` and parts without either are never cut, so the
 * safety notice always reaches the model. Undefined when even the smallest form does not fit.
 */
export function fitGroupHeader(
  information: string,
  parts: GroupContextPart[],
  omittedTasks: number,
  tail: string,
  limit: number,
): string | undefined {
  // Why a floor instead of a second abort: every part is group data the model can re-read with
  // read_messages, and brain re-validates access on every refresh. Stopping a run that already
  // did work costs more than a reference that only carries the safety notice.
  const trimmedNote =
    "Group data was cut to the minimum to fit the context window: members, tasks, messages and the source message are not listed. Use read_messages when you need them. / 群资料已按上下文窗口裁剪到最小：成员、任务、消息和来源消息都没列出，需要时用 read_messages 查询。";
  // Every line is followed by one "\n"; sizes are computed once so trimming stays linear.
  const line = (text: string) => Buffer.byteLength(text) + 1;
  const full = parts.map((part) => line(part.text));
  let total = line(information) + Buffer.byteLength(tail) + full.reduce((sum, n) => sum + n, 0);
  let omitted = omittedTasks;
  const fits = () => total + (omitted ? line(omittedNote(omitted)) : 0) <= limit;
  const dropped = new Set<number>();
  const tasks = parts
    .flatMap((part, index) => (part.taskRank === undefined ? [] : [index]))
    .sort((a, b) => (parts[a]?.taskRank ?? 0) - (parts[b]?.taskRank ?? 0) || a - b);
  for (const index of tasks) {
    if (fits()) break;
    dropped.add(index);
    total -= full[index] ?? 0;
    omitted++;
  }
  let compact = false;
  if (!fits()) {
    compact = true;
    parts.forEach((part, index) => {
      if (part.compact !== undefined && !dropped.has(index))
        total += line(part.compact) - (full[index] ?? 0);
    });
  }
  let trimmed = false;
  if (!fits()) {
    // A live part without a compact form (source attachments, saved-plan data) can exceed the whole
    // header on its own; dropping it still leaves a usable, honest reference.
    parts.forEach((_, index) => {
      if (dropped.has(index)) return;
      dropped.add(index);
      total -= full[index] ?? 0;
    });
    compact = false;
    trimmed = true;
    omitted = 0;
    total += line(trimmedNote);
  }
  if (!fits()) return undefined;
  const lines = [information];
  if (trimmed) lines.push(trimmedNote);
  parts.forEach((part, index) => {
    if (!dropped.has(index))
      lines.push(compact && part.compact !== undefined ? part.compact : part.text);
  });
  if (omitted) lines.push(omittedNote(omitted));
  return `${lines.join("\n")}\n${tail}`;
}
