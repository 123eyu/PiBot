import { groupSnapshot } from "./group-target.ts";
import type { RetroAttribution, RetroEvent, RetroGroupScope } from "./retro-types.ts";
import type { StepRecord, TaskRecord } from "./state.ts";

const tuple = (scope: RetroGroupScope) =>
  JSON.stringify([
    scope.groupId,
    scope.topicId,
    scope.cycleId,
    scope.budgetRootRunId,
    scope.runId,
    scope.assistantMessageId,
  ]);

export function groupAttribution(
  task: TaskRecord,
  actors: StepRecord[],
  explicit: RetroAttribution,
  sessionIds: string[],
): RetroAttribution {
  const groupId = task.target?.kind === "group" ? task.target.groupId : undefined;
  if (groupId !== undefined && !/^[a-zA-Z0-9:_-]{1,128}$/.test(groupId))
    throw new Error("retro_attribution_invalid");
  const scopes = new Map<string, RetroGroupScope>();
  const owners = new Map<string, string>();
  let complete = actors.length > 0;
  for (const record of [...actors, task]) {
    if (!record.group) {
      if (record !== task) complete = false;
      continue;
    }
    const snapshot = groupSnapshot(record.group);
    if (!snapshot) throw new Error("retro_attribution_invalid");
    if (!groupId) continue;
    if (snapshot.groupId !== groupId) throw new Error("retro_attribution_conflict");
    if (!snapshot.terminal || !snapshot.drained) complete = false;
    const key = tuple(snapshot);
    const scope = scopes.get(key) ?? {
      groupId,
      topicId: snapshot.topicId,
      cycleId: snapshot.cycleId,
      budgetRootRunId: snapshot.budgetRootRunId,
      runId: snapshot.runId,
      assistantMessageId: snapshot.assistantMessageId,
      runIds: [],
      runs: [],
    };
    const runs = new Map(scope.runs.map((run) => [run.runId, run]));
    for (const runId of snapshot.runIds) {
      if (owners.has(runId) && owners.get(runId) !== key)
        throw new Error("retro_attribution_conflict");
      owners.set(runId, key);
      if (owners.size > 1024) throw new Error("retro_attribution_invalid");
    }
    for (const { runId, botId, conversationId } of snapshot.runs) {
      const known = runs.get(runId);
      if (known && (known.botId !== botId || known.conversationId !== conversationId))
        throw new Error("retro_attribution_conflict");
      runs.set(runId, { runId, botId, conversationId });
    }
    scope.runIds = [...new Set([...scope.runIds, ...snapshot.runIds])].sort();
    scope.runs = [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId));
    scopes.set(key, scope);
  }
  const groupScopes = [...scopes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, s]) => s);
  const cycles = new Set(groupScopes.map((scope) => scope.cycleId));
  // Hints can confirm already-owned identities, never add another cycle/run or widen by session.
  if (
    (explicit.groupId !== undefined && explicit.groupId !== groupId) ||
    explicit.runIds?.some((runId) => !owners.has(runId)) ||
    explicit.cycleIds?.some((cycleId) => !cycles.has(cycleId)) ||
    explicit.sessionIds?.some((sessionId) => !sessionIds.includes(sessionId))
  )
    throw new Error("retro_attribution_conflict");
  return {
    runIds: [...owners.keys()].sort(),
    sessionIds,
    ...(groupId ? { groupId } : {}),
    cycleIds: [...cycles].sort(),
    groupScopes,
    groupCoverage: !groupScopes.length ? "unknown" : complete ? "complete" : "partial",
  };
}

export function groupEventOwner(attribution: RetroAttribution) {
  const owners = new Map<
    string,
    { scope: RetroGroupScope; botId?: string; conversationId?: string }
  >();
  for (const scope of attribution.groupScopes ?? []) {
    const runs = new Map(scope.runs.map((run) => [run.runId, run]));
    for (const runId of scope.runIds) owners.set(runId, { scope, ...runs.get(runId) });
  }
  return (event: RetroEvent) => {
    const owner = event.runId ? owners.get(event.runId) : undefined;
    if (!owner) return false;
    return (
      (!event.groupId || event.groupId === owner.scope.groupId) &&
      (!event.cycleId || event.cycleId === owner.scope.cycleId) &&
      (!event.topicId || event.topicId === owner.scope.topicId) &&
      (!event.budgetRootRunId || event.budgetRootRunId === owner.scope.budgetRootRunId) &&
      (!event.botId || !owner.botId || event.botId === owner.botId) &&
      (!event.conversationId ||
        !owner.conversationId ||
        event.conversationId === owner.conversationId)
    );
  };
}
