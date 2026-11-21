import type { Bot, EventPayloads, Group } from "@pibot/protocol";
import { type Peer, waitRpc } from "@pibot/renderer-kit";

export function statusKey(status: EventPayloads["chat.status"]) {
  return status.runId ?? JSON.stringify([status.conversationId, status.botId]);
}
export function applyStatus(
  previous: Record<string, EventPayloads["chat.status"]>,
  status: EventPayloads["chat.status"],
) {
  const statuses = { ...previous };
  const key = statusKey(status);
  const current = statuses[key];
  if (status.state !== "idle") statuses[key] = status;
  // A run id names exactly one run, but its message id advances: the brain's first "running"
  // carries none and tool rounds open new assistant messages, so idle must not require it.
  else if (status.runId !== null) {
    if (current?.runId === status.runId) delete statuses[key];
  } else if (
    current?.conversationId === status.conversationId &&
    current.botId === status.botId &&
    current.runId === status.runId &&
    current.messageId === status.messageId
  )
    delete statuses[key];
  return statuses;
}

export async function recoverGroupStatuses(
  peer: Peer,
  groups: Group[],
  parent: AbortSignal,
  bots: Bot[] = [],
) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(30_000)]);
  const statuses: Record<string, EventPayloads["chat.status"]> = {};
  const uncertain: string[] = [];
  const uncertainBots: string[] = [];
  const targets = [
    ...groups.map((group) => ({ group, botId: undefined })),
    ...bots.map((bot) => ({ group: undefined, botId: bot.id })),
  ];
  // Only visible sidebar groups; finite pages and bounded concurrency avoid catalog-wide IO.
  for (let index = 0; index < targets.length; index += 4) {
    await Promise.all(
      targets.slice(index, index + 4).map(async ({ group, botId }) => {
        const groupId = group?.id;
        let before: string | undefined;
        try {
          for (let page = 0; page < 25; page++) {
            const rows = await waitRpc(
              () => peer.call("chat.runs", { groupId, botId, before, limit: 200 }, { signal }),
              signal,
            );
            for (const run of rows)
              if (
                (groupId ? run.groupId === groupId : !run.groupId && run.botId === botId) &&
                (run.status === "running" || run.status === "queued")
              )
                statuses[run.id] = {
                  botId: run.botId,
                  groupId,
                  threadId:
                    group && run.conversationId !== group.conversationId
                      ? run.conversationId
                      : undefined,
                  conversationId: run.conversationId,
                  runId: run.id,
                  messageId: run.messageId,
                  state: run.status,
                };
            if (rows.length < 200) return;
            const next = rows.at(-1)?.id;
            if (!next || next === before) throw new Error("Repeated run cursor");
            before = next;
          }
          if (groupId) uncertain.push(groupId);
          else if (botId) uncertainBots.push(botId);
        } catch {
          parent.throwIfAborted();
          if (groupId) uncertain.push(groupId);
          else if (botId) uncertainBots.push(botId);
        }
      }),
    );
  }
  parent.throwIfAborted();
  return { statuses, uncertain, uncertainBots };
}
