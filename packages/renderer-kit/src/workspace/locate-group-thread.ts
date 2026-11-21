import type { Group } from "@pibot/protocol";
import type { View } from "../navigation/context.ts";
import type { Peer } from "../rpc/context.ts";
import { waitRpc } from "../rpc/wait.ts";
import { optional } from "./actions.ts";

export async function locateGroupThread(
  peer: Peer,
  groups: Group[],
  conversationId: string,
  signal: AbortSignal,
): Promise<View | undefined> {
  for (let index = 0; index < groups.length; index += 4) {
    const candidates = await Promise.all(
      groups.slice(index, index + 4).map(async (group) => {
        let before: string | undefined;
        for (let page = 0; page < 25; page++) {
          const tasks = await waitRpc(
            () => optional(peer.call("groups.tasks", { groupId: group.id, before, limit: 200 })),
            signal,
          );
          signal.throwIfAborted();
          if (!tasks) return;
          const task = tasks.find(
            (task) => task.groupId === group.id && task.threadConversationId === conversationId,
          );
          if (task)
            return {
              name: "chat" as const,
              groupId: group.id,
              threadId: task.threadConversationId,
            };
          const next = tasks.at(-1)?.id;
          if (tasks.length < 200 || !next || next === before) return;
          before = next;
        }
      }),
    );
    const target = candidates.find(Boolean);
    if (target) return target;
  }
}
