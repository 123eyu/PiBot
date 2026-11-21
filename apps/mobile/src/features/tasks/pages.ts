import { ContinuationPendingSchema, type MethodResults, Methods } from "@pibot/protocol";
import { z } from "zod";
import type { MobileRuntime } from "../../runtime/runtime.ts";
import type { Conversation } from "../conversations/model.ts";
import { RECORD_WINDOW_MS } from "../records/model.ts";

export type Run = MethodResults["chat.runs"][number];
export type RoutineRun = MethodResults["routines.history"][number];
const RUN_SOURCES = 20,
  PARALLEL = 4;
export const TaskCenterSchema = z.object({
  runs: Methods["chat.runs"].result,
  routines: Methods["routines.history"].result,
  chains: z.array(ContinuationPendingSchema).max(50),
  pausedUntil: z.string().max(40).nullable(),
});
export type TaskCenter = z.infer<typeof TaskCenterSchema>;

/**
 * chat.runs is scoped to one Bot or group, so the center reads the most recent conversations a
 * few at a time (the remote gateway caps concurrent requests). The computer
 * returns the last 3 days of runs to a phone, so the center shows the same window.
 */
async function readRuns(runtime: MobileRuntime, rows: Conversation[], signal: AbortSignal) {
  const sources = rows.slice(0, RUN_SOURCES);
  const runs: Run[] = [];
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const row = sources[next++] as Conversation;
      const page = await runtime.call(
        "chat.runs",
        { ...(row.kind === "bot" ? { botId: row.id } : { groupId: row.id }), limit: 20 },
        signal,
      );
      runs.push(...page);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const since = Date.now() - RECORD_WINDOW_MS;
  const unique = new Map(
    runs.filter((run) => Date.parse(run.createdAt) >= since).map((run) => [run.id, run]),
  );
  return [...unique.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 200);
}
export async function readTaskCenter(
  runtime: MobileRuntime,
  rows: Conversation[],
  signal: AbortSignal,
): Promise<TaskCenter> {
  const from = new Date(Date.now() - RECORD_WINDOW_MS).toISOString();
  const [runs, routines, chains, summary] = await Promise.all([
    readRuns(runtime, rows, signal),
    runtime.call("routines.history", { from, limit: 100 }, signal),
    runtime.call("continuations.list", { limit: 50 }, signal),
    runtime.call("routines.summary", undefined, signal),
  ]);
  return { runs, routines, chains: chains.items, pausedUntil: summary.pausedUntil };
}
export const isActive = (run: Run) => ["queued", "running", "waiting"].includes(run.status);
/** One row per routine: its most recent run in the window (history is newest first). */
export function latestByRoutine(routines: RoutineRun[]) {
  const seen = new Map<string, RoutineRun>();
  for (const run of routines)
    if (run.routineId && !seen.has(run.routineId)) seen.set(run.routineId, run);
  return [...seen.values()];
}
export function retryParams(run: Run) {
  return run.groupId && run.taskId
    ? {
        source: "group" as const,
        botId: run.botId,
        conversationId: run.conversationId,
        failedRunId: run.id,
        groupId: run.groupId,
        taskId: run.taskId,
      }
    : {
        source: "dm" as const,
        botId: run.botId,
        conversationId: run.conversationId,
        failedRunId: run.id,
      };
}
