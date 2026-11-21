import { type Message, previewKind } from "@pibot/protocol";
import type { FileCache } from "../../storage/file-cache.ts";
import { StoredTopicsSchema, storeKeys } from "../../storage/phone-store.ts";
import type { MobileStorage } from "../../storage/state.ts";
import { listTopics } from "../chat/controls/calls.ts";
import { type Caller, type ChatScope, scopeTarget } from "../chat/controls/scope.ts";
import { readHistoryDelta } from "../chat/history-sync.ts";
import type { Conversation } from "../conversations/model.ts";
import { fetchPreviewFile } from "../files/fetch-file.ts";
import { type FileSource, sourceKey } from "../files/source.ts";

/**
 * Caps of the background sync (2026-10-22). History pages stay at 50
 * messages so one reply fits a phone frame; the local history cache keeps at most 100 per topic.
 */
export const SYNC_LIMITS = {
  conversations: 20,
  messages: 50,
  prefetchFileBytes: 5 * 1024 * 1024,
  prefetchPerPass: 40,
} as const;

/**
 * Refreshes the cached current topic and latest history page of one conversation, under the
 * same storage keys the chat page reads offline (topics list and history).
 */
export async function syncConversation(
  c: Caller,
  storage: MobileStorage,
  computerId: string,
  row: Pick<Conversation, "kind" | "id" | "topicId">,
  signal: AbortSignal,
): Promise<Message[]> {
  const topics = await listTopics(c, row.kind, row.id, signal);
  // Same choice as the chat page's topic hook, so offline it opens the same topic.
  const current = topics.find((topic) => topic.isCurrent)?.id ?? row.topicId ?? topics[0]?.id;
  await storage.store.write(
    storeKeys.topics(computerId, row.kind, row.id),
    StoredTopicsSchema.parse({ current, topics: topics.slice(0, 50) }),
  );
  if (!current) return [];
  const scope: ChatScope = { kind: row.kind, id: row.id, topicId: current };
  const target = scopeTarget(scope);
  const key = JSON.stringify(target);
  // Proposal 4: a reconnect reads the newest few messages per conversation, not a page each.
  const local = (await storage.history(computerId, key)).filter((m) => m.status !== "streaming");
  const { messages } = await readHistoryDelta(c, target, local, signal, 30_000);
  signal.throwIfAborted();
  await storage.cacheHistory(computerId, key, messages);
  return messages;
}
export interface PrefetchItem {
  source: FileSource;
  name: string;
}
/** Images and small previewable files of the given messages, newest first. */
export function prefetchCandidates(messages: Message[]): PrefetchItem[] {
  const items: PrefetchItem[] = [];
  for (const message of [...messages].reverse())
    for (const attachment of message.attachments ?? [])
      if (attachment.size <= SYNC_LIMITS.prefetchFileBytes && previewKind(attachment.name))
        items.push({
          source: { attachmentId: attachment.id, messageId: message.id },
          name: attachment.name,
        });
  return items;
}
/**
 * Downloads uncached items one at a time (attachments never change, so a cached one is never
 * re-read). Stops at the per-pass cap or when the signal ends (disconnect, background).
 */
export async function prefetchFiles(
  c: Caller,
  cache: FileCache,
  computerId: string,
  items: PrefetchItem[],
  signal: AbortSignal,
) {
  let fetched = 0;
  for (const item of items) {
    if (fetched >= SYNC_LIMITS.prefetchPerPass) break;
    signal.throwIfAborted();
    if (await cache.peek(computerId, sourceKey(item.source))) continue;
    try {
      await fetchPreviewFile(
        c,
        cache,
        { computerId, online: true, source: item.source, name: item.name },
        signal,
      );
      fetched++;
    } catch (error) {
      if (signal.aborted) throw error;
      // A missing or unsupported file is skipped; the user still sees the chip and can retry.
    }
  }
  return fetched;
}
