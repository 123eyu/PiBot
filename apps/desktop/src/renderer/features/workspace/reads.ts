import {
  type Bot,
  type Group,
  messageAnswerText,
  RpcError,
  RpcErrorCodes,
  type SidebarEntry,
} from "@pibot/protocol";
import { optional, type Peer, type Summary } from "@pibot/renderer-kit";

async function metadata<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await optional(request);
  } catch (error) {
    // Missing/archived entries and members keep group history, without inventing a replacement Bot.
    if (error instanceof RpcError && error.code === RpcErrorCodes.invalidParams) return undefined;
    throw error;
  }
}

// A page of summaries has at most four concurrent reads; stale peer/page results cannot publish.
export async function summaries(
  peer: Peer,
  entries: SidebarEntry[],
  bots: Bot[],
  groups: Group[],
  signal: AbortSignal,
): Promise<Record<string, Summary>> {
  const result: Record<string, Summary> = {};
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (index < entries.length && !signal.aborted) {
        const entry = entries[index++];
        if (!entry) return;
        const [kind, id] = entry.conversationKey.split(":");
        const bot = bots.find((b) => b.id === id);
        const group = groups.find((g) => g.id === id);
        try {
          const topics =
            kind === "dm"
              ? await optional(
                  peer.call(
                    "topics.list",
                    { botId: id as string, withMessages: true, limit: 1 },
                    { signal },
                  ),
                )
              : undefined;
          signal.throwIfAborted();
          const topic = topics?.[0];
          if (topic && (topic.botId !== id || topic.kind !== "dm"))
            throw new Error("Topic preview mismatch");
          const topicId = topic?.id;
          const history = await optional(
            peer.call(
              "chat.history",
              kind === "dm"
                ? { botId: id as string, topicId, limit: 1 }
                : { groupId: id as string, limit: 1 },
              { signal },
            ),
          );
          const latest = history?.[0];
          const usage = latest?.usage;
          const systemEvent: NonNullable<Summary["previewSource"]>["systemEvent"] =
            usage &&
            typeof usage === "object" &&
            !Array.isArray(usage) &&
            usage.systemEvent === true
              ? usage.trigger === "background_finished" || usage.trigger === "background_restart"
                ? usage.trigger
                : "other"
              : undefined;
          result[entry.conversationKey] = {
            // A forward previews its note, never the forwarded material.
            preview:
              (history?.[0] && messageAnswerText(history[0])) ??
              bot?.description ??
              group?.announcement ??
              "",
            ...(latest
              ? {
                  previewSource: {
                    role: latest.role,
                    runId: latest.runId,
                    routineTrigger: latest.routineTrigger,
                    ...(systemEvent ? { systemEvent } : {}),
                  },
                }
              : {}),
            conversationId: history?.[0]?.conversationId ?? topicId ?? group?.conversationId,
            topicId,
            ...(history?.[0]?.status === "error"
              ? { failed: history[0].errorCode ?? "internal" }
              : {}),
            updatedAt:
              history?.[0]?.updatedAt ?? topic?.updatedAt ?? group?.updatedAt ?? bot?.updatedAt,
          };
        } catch {
          // A preview is supplementary; authoritative chat history has its own visible retry state.
          result[entry.conversationKey] = {
            preview: bot?.description ?? group?.announcement ?? "",
            conversationId: group?.conversationId,
          };
        }
      }
    }),
  );
  return result;
}

export async function hydrateEntries(
  peer: Peer,
  entries: SidebarEntry[],
  bots: Bot[],
  groups: Group[],
  parent: AbortSignal,
) {
  const read = new AbortController();
  const signal = AbortSignal.any([parent, read.signal]);
  try {
    const botMap = new Map(bots.map((bot) => [bot.id, bot]));
    const groupMap = new Map(groups.map((group) => [group.id, group]));
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (index < entries.length && !signal.aborted) {
          const entry = entries[index++];
          if (!entry) return;
          const [kind, id] = entry.conversationKey.split(":");
          if (kind === "dm" && id && !botMap.has(id)) {
            const profile = await metadata(peer.call("bots.profile", { botId: id }, { signal }));
            if (profile && profile.bot.id === id && !profile.bot.archivedAt)
              botMap.set(id, profile.bot);
          } else if (kind === "group" && id && !groupMap.has(id)) {
            const group = await metadata(peer.call("groups.get", { groupId: id }, { signal }));
            if (group && group.id === id) groupMap.set(id, group);
          }
        }
      }),
    );
    const members = [
      ...new Set(
        [...groupMap.values()].flatMap((group) => group.members.map((member) => member.botId)),
      ),
    ].filter((id) => !botMap.has(id));
    index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, members.length) }, async () => {
        while (index < members.length && !signal.aborted) {
          const id = members[index++];
          if (!id) return;
          const profile = await metadata(peer.call("bots.profile", { botId: id }, { signal }));
          if (profile && profile.bot.id === id && !profile.bot.archivedAt)
            botMap.set(id, profile.bot);
        }
      }),
    );
    signal.throwIfAborted();
    return { bots: [...botMap.values()], groups: [...groupMap.values()] };
  } finally {
    // Stop sibling workers after a failed page; accepted RPCs still settle through Promise.all.
    read.abort();
  }
}
