import type { ChatPeer } from "@pibot/client-core";
import { type Bot, type Group, type GroupTask, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";
import type { PublicRun } from "./data.ts";

export async function readGroupBots(peer: ChatPeer, group: Group, signal: AbortSignal) {
  const profiles = await Promise.all(
    group.members.map(({ botId }) =>
      waitRpc(() => peer.call("bots.profile", { botId }, { signal }), signal)
        .then(({ bot }) => {
          if (bot.id !== botId) throw new Error("Wrong member identity");
          return bot;
        })
        .catch((error: unknown) => {
          // Archived/missing members retain history without becoming the main Pi.
          if (error instanceof RpcError && error.code === RpcErrorCodes.invalidParams) return;
          throw error;
        }),
    ),
  );
  return profiles.filter((bot): bot is Bot => !!bot);
}

export async function readGroupTasks(
  peer: ChatPeer,
  groupId: string,
  wanted: number,
  signal: AbortSignal,
) {
  const tasks: GroupTask[] = [];
  let before: string | undefined;
  let hasMore = false;
  const cursors = new Set<string>();
  do {
    const page = await waitRpc(
      () => peer.call("groups.tasks", { groupId, before, limit: 50 }, { signal }),
      signal,
    );
    signal.throwIfAborted();
    if (page.some((task) => task.groupId !== groupId)) throw new Error("Wrong task scope");
    tasks.push(...page);
    hasMore = page.length === 50;
    const next = page.at(-1)?.id;
    if (next && cursors.has(next) && hasMore) throw new Error("Repeated task cursor");
    if (next) cursors.add(next);
    before = next;
  } while (hasMore && tasks.length < wanted);
  return { tasks, hasMore };
}

export async function readGroupRuns(
  peer: ChatPeer,
  groupId: string,
  signal: AbortSignal,
  firstPage: (runs: PublicRun[]) => void,
) {
  const runs: PublicRun[] = [];
  let before: string | undefined;
  let partialRuns = true;
  const cursors = new Set<string>();
  // Keep the original recovery budget; a capped scan can never certify idle.
  for (let page = 0; page < 25; page++) {
    const rows = await waitRpc(
      () => peer.call("chat.runs", { groupId, before, limit: 200 }, { signal }),
      signal,
    );
    signal.throwIfAborted();
    runs.push(...rows);
    if (page === 0) firstPage(rows);
    partialRuns = rows.length === 200;
    if (!partialRuns) break;
    const next = rows.at(-1)?.id;
    if (!next || cursors.has(next)) throw new Error("Repeated run cursor");
    cursors.add(next);
    before = next;
  }
  return { runs, partialRuns };
}
