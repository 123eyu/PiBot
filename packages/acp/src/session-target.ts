import type { SessionState } from "./state.ts";
import type { AcpBot, AcpGroup, AcpRuntimePort, AcpTarget } from "./types.ts";

export const targetModeId = (target: AcpTarget) =>
  target.kind === "group" ? `group:${target.groupId}` : target.botId;
export const sessionTarget = (state: Pick<SessionState, "target" | "botId">): AcpTarget =>
  state.target ?? { kind: "bot", botId: state.botId };
export const modeTarget = (mode: string): AcpTarget =>
  mode.startsWith("group:")
    ? { kind: "group", groupId: mode.slice(6) }
    : { kind: "bot", botId: mode };

export async function validateTarget(
  runtime: AcpRuntimePort,
  target: AcpTarget,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (target.kind === "group") {
    if (!runtime.group) throw new Error("acp_group_unsupported");
    const group = await runtime.group(target.groupId, signal);
    if (group.archivedAt || !group.memberBotIds.includes(group.coordinatorBotId))
      throw new Error("acp_group_unavailable");
    return group.coordinatorBotId;
  }
  const bot = (await runtime.bots(signal)).find(
    (bot) => bot.id === target.botId && !bot.archivedAt,
  );
  if (!bot) throw new Error("Unknown Bot mode");
  return bot.id;
}

export function requestedTarget(
  input: { "pibot/bot"?: string; "pibot/group"?: string } | undefined | null,
  bots: AcpBot[],
  groups: AcpGroup[],
): AcpTarget | undefined {
  if (input?.["pibot/bot"] && input["pibot/group"]) throw new Error("acp_target_ambiguous");
  const group = input?.["pibot/group"];
  if (group) {
    const key = group.startsWith("group:") ? group.slice(6) : group;
    const byId = groups.find((entry) => entry.id === key);
    const named = byId
      ? [byId]
      : group.startsWith("group:")
        ? []
        : groups.filter((entry) => entry.name === key);
    if (named.length !== 1 || !named[0]) throw new Error("acp_group_unavailable");
    return { kind: "group", groupId: named[0].id };
  }
  const requested = input?.["pibot/bot"];
  if (!requested) return undefined;
  const byId = bots.find((entry) => entry.id === requested);
  const named = byId ? [byId] : bots.filter((entry) => entry.name === requested);
  if (named.length !== 1 || !named[0]) throw new Error("Unknown Bot mode");
  return { kind: "bot", botId: named[0].id };
}

export async function createTargetTopic(
  runtime: AcpRuntimePort,
  target: AcpTarget,
  roots: string[],
  yolo: boolean,
  signal: AbortSignal,
  topicId?: string,
) {
  const botId = await validateTarget(runtime, target, signal);
  const input = { cwd: roots[0] as string, additionalDirectories: roots.slice(1), yolo };
  let topic: { topicId: string };
  if (target.kind === "group") {
    if (topicId) {
      if (!runtime.attachGroupTopic) throw new Error("acp_group_unsupported");
      topic = await runtime.attachGroupTopic(
        { groupId: target.groupId, topicId, cwd: input.cwd },
        signal,
      );
    } else {
      if (!runtime.createGroupTopic) throw new Error("acp_group_unsupported");
      topic = await runtime.createGroupTopic({ ...input, groupId: target.groupId }, signal);
    }
  } else {
    topic = topicId
      ? await runtime.attachTopic({ botId, topicId, cwd: input.cwd }, signal)
      : await runtime.createTopic({ ...input, botId }, signal);
  }
  return { ...topic, botId };
}

export async function rebindTargetTopic(
  runtime: AcpRuntimePort,
  target: AcpTarget,
  topicId: string,
  roots: string[],
  signal: AbortSignal,
) {
  await validateTarget(runtime, target, signal);
  const input = { topicId, cwd: roots[0] as string, additionalDirectories: roots.slice(1) };
  if (target.kind === "group") {
    if (!runtime.rebindGroupTopic) throw new Error("acp_group_unsupported");
    await runtime.rebindGroupTopic({ ...input, groupId: target.groupId }, signal);
  } else await runtime.rebindTopic({ ...input, botId: target.botId }, signal);
}

export async function archiveTargetTopic(
  runtime: AcpRuntimePort,
  target: AcpTarget,
  topicId: string,
  signal: AbortSignal,
) {
  if (target.kind === "group") {
    if (!runtime.archiveGroupTopic) throw new Error("acp_group_unsupported");
    await runtime.archiveGroupTopic({ groupId: target.groupId, topicId }, signal);
  } else await runtime.archiveTopic({ botId: target.botId, topicId }, signal);
}
