import { createHash } from "node:crypto";
import { groupSnapshot } from "./group-target.ts";
import { groupAttribution, groupEventOwner } from "./retro-attribution.ts";
import type { RetroAttribution, RetroEvent, RetroMetric, RetroSummary } from "./retro-types.ts";
import type { StepRecord, TaskRecord } from "./state.ts";

export const actorStep = (step: string) => ["task", "fix", "test"].includes(step);
export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
export function actorWindow(step: StepRecord) {
  const to = Date.parse(step.at);
  const from = finite(step.durationMs) ? to - step.durationMs : NaN;
  const complete = Number.isFinite(to) && Number.isFinite(new Date(from).getTime());
  return { to, from: complete ? from : to, complete };
}
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
const ids = (values: unknown) => {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 1024 || !values.every(id))
    throw new Error("retro_attribution_invalid");
  return [...new Set(values)].sort();
};
export function attribution(task: TaskRecord, explicit: RetroAttribution = {}): RetroAttribution {
  if (explicit.groupId !== undefined && !id(explicit.groupId))
    throw new Error("retro_attribution_invalid");
  const steps = task.steps.filter((step) => actorStep(step.step));
  const sessions = ids([...steps.flatMap((step) => (step.sessionId ? [step.sessionId] : []))]);
  if (task.target?.kind === "group")
    return groupAttribution(
      task,
      steps,
      {
        ...explicit,
        runIds: ids(explicit.runIds),
        sessionIds: ids(explicit.sessionIds),
        cycleIds: ids(explicit.cycleIds),
      },
      sessions,
    );
  return {
    runIds: ids([
      ...ids(explicit.runIds),
      ...steps.flatMap((step) => (step.runId ? [step.runId] : [])),
    ]),
    sessionIds: ids([
      ...ids(explicit.sessionIds),
      ...steps.flatMap((step) => (step.sessionId ? [step.sessionId] : [])),
    ]),
    ...(explicit.groupId ? { groupId: explicit.groupId } : {}),
    cycleIds: ids(explicit.cycleIds),
  };
}
export function taskDigest(task: TaskRecord) {
  // No prompt, exception detail, or log path enters the persisted fact identity.
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: task.id,
        branch: task.branch,
        worktree: task.worktree,
        botId: task.botId,
        target: task.target,
        group: task.group ? groupSnapshot(task.group) : undefined,
        steps: task.steps.map(
          ({
            step,
            at,
            outcome,
            durationMs,
            tools,
            failedTools,
            usage,
            sessionId,
            runId,
            group,
          }) => ({
            step,
            at,
            outcome,
            durationMs,
            tools,
            failedTools,
            usage,
            sessionId,
            runId,
            group: group ? groupSnapshot(group) : undefined,
          }),
        ),
      }),
    )
    .digest("hex");
}
export const metric = (
  value: number | null,
  coverage: RetroMetric["coverage"] = "complete",
): RetroMetric => ({
  value: finite(value) ? value : null,
  coverage: finite(value) ? coverage : "unknown",
});
function sum(values: unknown[]) {
  const known = values.filter(finite);
  return metric(
    known.length ? known.reduce((a, b) => a + b, 0) : null,
    known.length === values.length ? "complete" : "partial",
  );
}
export function buildRetro(
  task: TaskRecord,
  input: {
    attribution: RetroAttribution;
    events: RetroEvent[];
    logSource: RetroSummary["logSource"];
    generatedAt: string;
  },
): RetroSummary {
  const positions = new Map<string, number>();
  const recorded: TaskRecord["steps"] = [];
  for (const step of task.steps) {
    const key = step.runId ? `${step.step}:${step.runId}` : undefined;
    const previous = key ? positions.get(key) : undefined;
    if (previous !== undefined) recorded[previous] = step;
    else {
      if (key) positions.set(key, recorded.length);
      recorded.push(step);
    }
  }
  const actors = recorded.filter((step) => actorStep(step.step));
  const runIds = new Set(input.attribution.runIds);
  const sessions = new Set(input.attribution.sessionIds);
  const cycles = new Set(input.attribution.cycleIds);
  const ownsGroupEvent =
    task.target?.kind === "group" ? groupEventOwner(input.attribution) : undefined;
  const events = input.events.filter((event) => {
    if (event.taskId && event.taskId !== task.id) return false;
    if (ownsGroupEvent) return ownsGroupEvent(event);
    if (event.botId && task.botId && !input.attribution.groupId && event.botId !== task.botId)
      return false;
    if (event.groupId && event.groupId !== input.attribution.groupId) return false;
    if (cycles.size && (!event.cycleId || !cycles.has(event.cycleId))) return false;
    // Milestones reuse sessions across tasks. A session alone never proves task ownership.
    return (
      !!(event.runId && runIds.has(event.runId)) ||
      !!(event.taskId === task.id && event.sessionId && sessions.has(event.sessionId))
    );
  });
  const completeRuns = new Set(
    events.filter((event) => event.event === "run_end").map((event) => event.runId),
  );
  const complete =
    input.logSource.status === "available" &&
    actors.length > 0 &&
    actors.every((step) => actorWindow(step).complete) &&
    (!ownsGroupEvent || input.attribution.groupCoverage === "complete") &&
    runIds.size > 0 &&
    [...runIds].every((runId) => completeRuns.has(runId));
  const logged = (value: number, observed: boolean) =>
    metric(complete || observed ? value : null, complete ? "complete" : "partial");
  const tools = events.filter((event) => event.event === "tool_result");
  const failed = tools.filter((event) => event.failed);
  const counts: RetroSummary["steps"] = {};
  for (const step of recorded) {
    const outcomes: Record<string, number> = counts[step.step] ?? {};
    counts[step.step] = outcomes;
    outcomes[step.outcome] = (outcomes[step.outcome] ?? 0) + 1;
  }
  const firstStep = task.steps[0];
  const firstWindow = firstStep ? actorWindow(firstStep) : undefined;
  const first = firstWindow?.complete ? firstWindow.from : NaN;
  const last = Date.parse(task.steps.at(-1)?.at ?? "");
  const usage = Object.fromEntries(
    (["requests", "input", "output", "cacheRead", "cacheWrite"] as const).map((key) => [
      key,
      sum(actors.map((step) => step.usage?.[key])),
    ]),
  ) as RetroSummary["usage"];
  const stepTools = sum(actors.map((step) => step.tools));
  const stepFailed = sum(actors.map((step) => step.failedTools));
  const requests = events.filter((event) => event.event === "model_request").length;
  const reconnects = events.filter((event) => event.event === "model_reconnect").length;
  return {
    version: 1,
    taskId: task.id,
    inputDigest: taskDigest(task),
    generatedAt: input.generatedAt,
    publication: "pending",
    attribution: input.attribution,
    logSource: input.logSource,
    steps: counts,
    usage,
    metrics: {
      elapsedMs: metric(
        Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : null,
      ),
      actorMs: sum(actors.map((step) => step.durationMs)),
      tools: stepTools.value !== null ? stepTools : logged(tools.length, tools.length > 0),
      failedTools:
        stepFailed.value !== null ? stepFailed : logged(failed.length, failed.length > 0),
      modelRequests:
        usage.requests.value !== null ? usage.requests : logged(requests, requests > 0),
      reconnects: logged(reconnects, reconnects > 0),
      toolMs: tools.some((event) => !finite(event.durationMs))
        ? sum(tools.map((event) => event.durationMs))
        : logged(
            tools.reduce((n, event) => n + (event.durationMs ?? 0), 0),
            tools.length > 0,
          ),
    },
    failures: Object.fromEntries(
      (["policy", "sandbox", "tool", "other"] as const).map((kind) => {
        const value = failed.filter((event) => event.failure === kind).length;
        return [kind, logged(value, value > 0)];
      }),
    ) as RetroSummary["failures"],
  };
}
