import type { Bot, Group } from "@pibot/protocol";
import type { View } from "../navigation/context.ts";
import type { Peer } from "../rpc/context.ts";
import { optional } from "./actions.ts";
import { locateGroupThread } from "./locate-group-thread.ts";

// User messages have no owner. Paginated topics establish identity; a Bot UUID
// must never substitute for a conversation UUID or open an unrelated recent topic.
export async function locateConversation(
  peer: Peer,
  conversationId: string,
  signal: AbortSignal,
  bots: Bot[],
  groups: Group[],
  botId?: string,
): Promise<View> {
  signal.throwIfAborted();
  const knownGroup = groups.find((group) => group.conversationId === conversationId);
  if (knownGroup) return { name: "chat", groupId: knownGroup.id };
  const knownThread = await locateGroupThread(peer, groups, conversationId, signal);
  if (knownThread) return knownThread;
  const visitedGroups = new Set(groups.map((group) => group.id));
  let before: string | undefined;
  do {
    signal.throwIfAborted();
    const page = (await optional(peer.call("groups.list", { before, limit: 200 }))) ?? [];
    signal.throwIfAborted();
    const group = page.find((group) => group.conversationId === conversationId);
    if (group) return { name: "chat", groupId: group.id };
    const thread = await locateGroupThread(
      peer,
      page.filter((group) => !visitedGroups.has(group.id)),
      conversationId,
      signal,
    );
    if (thread) return thread;
    for (const group of page) visitedGroups.add(group.id);
    const cursor = page.at(-1)?.id;
    if (page.length < 200 || !cursor || cursor === before) break;
    before = cursor;
  } while (before);
  const visited = new Set<string>();
  const find = async (id: string): Promise<View | undefined> => {
    if (visited.has(id)) return;
    visited.add(id);
    let before: string | undefined;
    do {
      signal.throwIfAborted();
      const topics = await optional(peer.call("topics.list", { botId: id, before, limit: 200 }));
      signal.throwIfAborted();
      if (!topics) {
        const history = await peer.call("chat.history", { botId: id, limit: 1 });
        signal.throwIfAborted();
        return history[0]?.conversationId === conversationId
          ? { name: "chat", botId: id }
          : undefined;
      }
      if (
        topics.some(
          (topic) => topic.id === conversationId && topic.botId === id && topic.kind === "dm",
        )
      )
        return { name: "chat", botId: id, topicId: conversationId };
      const cursor = topics.at(-1)?.id;
      if (topics.length < 200 || !cursor || cursor === before) return;
      before = cursor;
    } while (before);
  };
  if (botId) {
    const target = await find(botId);
    if (target) return target;
  }
  const scan = async (page: Bot[]) => {
    for (let index = 0; index < page.length; index += 4) {
      signal.throwIfAborted();
      const found = await Promise.all(page.slice(index, index + 4).map((bot) => find(bot.id)));
      signal.throwIfAborted();
      const target = found.find(Boolean);
      if (target) return target;
    }
  };
  const known = await scan(bots);
  if (known) return known;
  before = undefined;
  do {
    signal.throwIfAborted();
    const page: Bot[] = await peer.call("bots.list", { before, limit: 200 });
    signal.throwIfAborted();
    const target = await scan(page);
    if (target) return target;
    const cursor = page.at(-1)?.id;
    if (page.length < 200 || !cursor || cursor === before) break;
    before = cursor;
  } while (before);
  throw new Error("Conversation owner unavailable");
}
