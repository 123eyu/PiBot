import { Methods } from "@pibot/protocol";
import { z } from "zod";
import type { Caller } from "../chat/controls/scope.ts";

/** Where a run's changes are looked up; the computer checks the run belongs to it. */
export interface ChangesTarget {
  conversationKey: string;
  topicId?: string;
}
export const TurnSchema = Methods["changes.turn"].result;
export const DiffSchema = Methods["changes.diff"].result;

export function runTarget(run: { botId: string; groupId?: string | null }): ChangesTarget {
  return { conversationKey: run.groupId ? `group:${run.groupId}` : `dm:${run.botId}` };
}
export function readRunTurn(c: Caller, runId: string, signal?: AbortSignal) {
  return c.call("changes.turn", { runId }, signal, 30_000);
}
/** The phone gateway only allows the "turn" scope: the run's own recorded snapshots. */
export function readTurnDiff(
  c: Caller,
  target: ChangesTarget,
  runId: string,
  path: string,
  signal?: AbortSignal,
) {
  return c.call("changes.diff", { ...target, path, scope: "turn", runId }, signal, 30_000);
}
export function readTurnLines(
  c: Caller,
  input: { target: ChangesTarget; runId: string; path: string; from: number; count: number },
  signal?: AbortSignal,
) {
  return c.call(
    "changes.lines",
    {
      ...input.target,
      path: input.path,
      scope: "turn",
      runId: input.runId,
      from: input.from,
      count: Math.min(input.count, 500),
    },
    signal,
    30_000,
  );
}

const key = z.string().regex(/^(dm|group):[0-9a-f-]{36}$/);
const RunParams = z.object({ runId: z.uuid(), key, topic: z.uuid().optional() });
const DiffParams = z.object({
  run: z.uuid(),
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(4096),
  key,
  topic: z.uuid().optional(),
  pv: z.enum(["1"]).optional(),
});
const targetParams = (target: ChangesTarget) => ({
  key: target.conversationKey,
  ...(target.topicId ? { topic: target.topicId } : {}),
});
export function runChangesHref(runId: string, target: ChangesTarget) {
  return { pathname: "/changes/[runId]" as const, params: { runId, ...targetParams(target) } };
}
export function diffHref(
  runId: string,
  target: ChangesTarget,
  file: { path: string; displayPath: string; previewable?: boolean },
) {
  return {
    pathname: "/diff" as const,
    params: {
      run: runId,
      path: file.path,
      name: file.displayPath,
      ...targetParams(target),
      ...(file.previewable ? { pv: "1" } : {}),
    },
  };
}
const target = (value: { key: string; topic?: string }): ChangesTarget => ({
  conversationKey: value.key,
  ...(value.topic ? { topicId: value.topic } : {}),
});
export function parseRunParams(input: unknown) {
  const parsed = RunParams.safeParse(input);
  return parsed.success ? { runId: parsed.data.runId, target: target(parsed.data) } : undefined;
}
export function parseDiffParams(input: unknown) {
  const parsed = DiffParams.safeParse(input);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return {
    runId: value.run,
    path: value.path,
    name: value.name,
    previewable: value.pv === "1",
    target: target(value),
  };
}
