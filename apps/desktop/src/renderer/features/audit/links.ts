import type { AuditEntry, Message } from "@pibot/protocol";
import { locateGroupThread, type Peer, type View } from "@pibot/renderer-kit";
import { auditRead } from "./rpc.ts";

/** Only a message with the exact run/tool identity establishes the source; never use the current DM. */
export async function locateAuditConversation(
  peer: Peer,
  entry: AuditEntry,
  signal: AbortSignal,
): Promise<View> {
  if (!entry.runId) throw new Error("Audit run unavailable");
  const find = async (
    target: { botId: string; topicId: string } | { groupId: string; threadId?: string },
  ) => {
    let before: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
      const page: Message[] = await auditRead(
        () => peer.call("chat.history", { ...target, limit: 200, ...(before ? { before } : {}) }),
        signal,
      );
      const message = page.find(
        (message) =>
          message.runId === entry.runId &&
          (message.botId === entry.botId || ("botId" in target && target.botId === entry.botId)) &&
          (!entry.detail.toolCallId ||
            message.tools?.some((tool) => tool.toolCallId === entry.detail.toolCallId)),
      );
      if (message)
        return {
          name: "chat" as const,
          ...target,
          focus: {
            messageId: message.id,
            ...(entry.detail.toolCallId ? { toolCallId: entry.detail.toolCallId } : {}),
          },
        };
      const cursor = page.at(0)?.id;
      if (page.length < 200 || !cursor) break;
      if (seen.has(cursor)) throw new Error("Message cursor repeated");
      seen.add(cursor);
      before = cursor;
    }
  };
  // The persistent run ledger provides group ownership even when a thread is not currently open.
  let runCursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
    const runs = await auditRead(
      () => peer.call("chat.runs", { botId: entry.botId, before: runCursor, limit: 200 }),
      signal,
    );
    const run = runs.find((run) => run.id === entry.runId && run.botId === entry.botId);
    if (run) {
      if (run.groupId) {
        const group = await auditRead(
          () => peer.call("groups.get", { groupId: run.groupId as string }),
          signal,
        );
        const target =
          group.conversationId === run.conversationId
            ? { name: "chat" as const, groupId: group.id }
            : await locateGroupThread(peer, [group], run.conversationId, signal);
        if (!target?.groupId) throw new Error("Audit thread unavailable");
        const found = await find({ groupId: target.groupId, threadId: target.threadId });
        if (found) return found;
        throw new Error("Audit message unavailable");
      }
      break;
    }
    const next = runs.at(-1)?.id;
    if (runs.length < 200 || !next || next === runCursor) break;
    runCursor = next;
  }
  let before: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
    const topics = await auditRead(
      () =>
        peer.call("topics.list", { botId: entry.botId, limit: 200, ...(before ? { before } : {}) }),
      signal,
    );
    for (const topic of topics) {
      if (topic.botId !== entry.botId || topic.kind !== "dm")
        throw new Error("Topic scope mismatch");
      const target = await find({ botId: entry.botId, topicId: topic.id });
      if (target) return target;
    }
    const cursor = topics.at(-1)?.id;
    if (topics.length < 200 || !cursor) break;
    if (seen.has(cursor)) throw new Error("Topic cursor repeated");
    seen.add(cursor);
    before = cursor;
  }
  throw new Error("Audit conversation unavailable within lookup bounds");
}

export async function auditCommandSource(peer: Peer, entry: AuditEntry, signal: AbortSignal) {
  if (
    !entry.runId ||
    !entry.detail.toolCallId ||
    entry.detail.command ||
    !(entry.kind.startsWith("exec.") || entry.detail.category === "run_command")
  )
    return;
  let before: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
    const page = await auditRead(
      () =>
        peer.call("audit.list", {
          botId: entry.botId,
          kind: "exec.started",
          limit: 200,
          ...(before ? { before } : {}),
        }),
      signal,
    );
    const source = page.find(
      (source) =>
        source.botId === entry.botId &&
        source.runId === entry.runId &&
        source.detail.toolCallId === entry.detail.toolCallId,
    );
    if (source) return source;
    const cursor = page.at(-1)?.id;
    if (page.length < 200 || !cursor) return;
    if (seen.has(cursor)) throw new Error("Audit cursor repeated");
    seen.add(cursor);
    before = cursor;
  }
}
