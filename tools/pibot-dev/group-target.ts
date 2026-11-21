import type { AcpGroupSnapshot } from "../../packages/acp/src/types.ts";

export type TaskTarget =
  | { kind: "bot"; name: string }
  | { kind: "group"; name: string; groupId?: string };
export function taskActor(args: string[], fallback: string) {
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const text = args[at + 1];
    if (!text || text.startsWith("--") || text.length > 200 || /[\0\r\n]/.test(text))
      throw new Error("task_target_invalid");
    return text;
  };
  if (args.includes("--bot") && args.includes("--group")) throw new Error("task_target_ambiguous");
  if (args.includes("--group") && args.includes("--model"))
    throw new Error("group_model_unsupported");
  const group = value("--group"),
    bot = value("--bot") ?? fallback;
  if (group?.startsWith("group:") && !/^[a-zA-Z0-9:_-]{1,128}$/.test(group.slice(6)))
    throw new Error("task_target_invalid");
  return group
    ? {
        bot: group,
        target: {
          kind: "group" as const,
          name: group,
          ...(group.startsWith("group:") ? { groupId: group.slice(6) } : {}),
        },
      }
    : { bot, target: { kind: "bot" as const, name: bot } };
}
export function targetKey(target: TaskTarget | undefined, bot: string) {
  return target?.kind === "group"
    ? `group:${target.groupId ?? target.name}`
    : `bot:${target?.name ?? bot}`;
}
const states = new Set([
  "running",
  "waiting_plan",
  "waiting_input",
  "paused",
  "limited",
  "failed",
  "cancelled",
  "completed",
]);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 1024 &&
  value.every(id) &&
  new Set(value).size === value.length;
/** ACP is an external boundary; retain only the bounded identity/status projection, never prose. */
export function groupSnapshot(value: unknown): AcpGroupSnapshot | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  for (const key of [
    "runId",
    "assistantMessageId",
    "groupId",
    "topicId",
    "cycleId",
    "budgetRootRunId",
  ])
    if (!id(row[key])) return;
  for (const key of ["runIds", "activeRunIds", "conversationIds", "taskIds", "workflowRunIds"])
    if (!ids(row[key])) return;
  if (
    typeof row.state !== "string" ||
    !states.has(row.state) ||
    typeof row.complete !== "boolean" ||
    typeof row.terminal !== "boolean" ||
    typeof row.drained !== "boolean" ||
    !Array.isArray(row.runs) ||
    row.runs.length > 1024
  )
    return;
  const runIds = new Set(row.runIds as string[]);
  if (
    !runIds.has(row.runId as string) ||
    (row.activeRunIds as string[]).some((runId) => !runIds.has(runId)) ||
    (row.drained && (row.activeRunIds as string[]).length > 0) ||
    (row.terminal && !["completed", "failed", "cancelled"].includes(row.state)) ||
    (row.terminal && row.state === "completed" && !row.complete) ||
    (row.complete && (row.state !== "completed" || !row.terminal || !row.drained))
  )
    return;
  const runs: AcpGroupSnapshot["runs"] = [];
  const seen = new Set<string>();
  for (const item of row.runs) {
    if (
      !item ||
      !id(item.runId) ||
      !id(item.botId) ||
      !id(item.conversationId) ||
      typeof item.status !== "string" ||
      !/^[a-z_]{1,40}$/.test(item.status)
    )
      return;
    if (!runIds.has(item.runId) || seen.has(item.runId)) return;
    seen.add(item.runId);
    runs.push({
      runId: item.runId,
      botId: item.botId,
      conversationId: item.conversationId,
      status: item.status,
    });
  }
  return {
    runId: row.runId as string,
    assistantMessageId: row.assistantMessageId as string,
    groupId: row.groupId as string,
    topicId: row.topicId as string,
    cycleId: row.cycleId as string,
    budgetRootRunId: row.budgetRootRunId as string,
    state: row.state as AcpGroupSnapshot["state"],
    runIds: [...(row.runIds as string[])],
    activeRunIds: [...(row.activeRunIds as string[])],
    conversationIds: [...(row.conversationIds as string[])],
    taskIds: [...(row.taskIds as string[])],
    workflowRunIds: [...(row.workflowRunIds as string[])],
    runs,
    complete: row.complete,
    terminal: row.terminal,
    drained: row.drained,
  };
}
