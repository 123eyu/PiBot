import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask } from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";

/** Count every page without retaining task instructions or mistaking the loaded list for a total. */
export async function memberTaskCounts(
  peer: ChatPeer,
  groupId: string,
  botId: string,
  signal: AbortSignal,
) {
  let before: string | undefined;
  const cursors = new Set<string>();
  let total = 0;
  let open = 0;
  let assigned = 0;
  for (;;) {
    const page: GroupTask[] = await waitRpc(
      () => peer.call("groups.tasks", { groupId, before, limit: 200 }, { signal }),
      signal,
    );
    signal.throwIfAborted();
    for (const task of page) {
      if (task.groupId !== groupId) throw new Error("Task group mismatch");
      if (task.assigneeBotId === botId) {
        total++;
        if (task.status === "open") open++;
      }
      if (task.createdByBotId === botId) assigned++;
    }
    if (page.length < 200) return { total, open, assigned };
    const cursor = page.at(-1)?.id;
    if (!cursor || cursors.has(cursor)) throw new Error("Task cursor did not advance");
    cursors.add(cursor);
    before = cursor;
  }
}
