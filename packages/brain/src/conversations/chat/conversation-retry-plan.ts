import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { inspectRetrySession, resolveSessionFile } from "@pibot/agent";
import { chatAddition, type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationRetriesRepo,
  ConversationsRepo,
  FileCheckpointsRepo,
  MessagesRepo,
  RunFileChangesRepo,
  RunsRepo,
} from "@pibot/storage";

type Source = KernelMethodParams["chat.retryPreview"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Freeze trusted history and checkpoint identities without exposing SDK paths to the renderer. */
export function createConversationRetryPlan({
  db,
  dataDir,
  platform,
}: {
  db: DatabaseSync;
  dataDir: string;
  platform: NodeJS.Platform;
}) {
  const repo = new ConversationRetriesRepo(db),
    messages = new MessagesRepo(db),
    conversations = new ConversationsRepo(db),
    checkpoints = new FileCheckpointsRepo(db);
  const target = (s: Source) => ({ conversationKey: `dm:${s.botId}`, topicId: s.conversationId });
  function source(s: Source) {
    const topic = conversations.get(s.conversationId),
      bot = new BotsRepo(db).get(s.botId),
      message = messages.get(s.messageId);
    const originId = repo.boundary(s.messageId)?.origin;
    const origin = originId ? messages.get(originId) : message;
    const isAddition =
      !!origin &&
      chatAddition(origin)?.state === "processed" &&
      !!repo.boundary(s.messageId)?.entry;
    const run = origin?.runId ? new RunsRepo(db).get(origin.runId) : undefined;
    if (
      !bot ||
      bot.archivedAt ||
      bot.category === "image" ||
      topic?.kind !== "dm" ||
      topic.botId !== bot.id ||
      topic.archivedAt ||
      topic.routineId ||
      conversations.isInternal(topic.id) ||
      !message ||
      message.conversationId !== topic.id ||
      message.role !== "user" ||
      message.status !== "done" ||
      !run ||
      (run.userMessageId !== origin?.id && !isAddition) ||
      run.conversationId !== origin?.conversationId ||
      run.botId !== bot.id ||
      !run.startedAt ||
      !run.finishedAt ||
      !run.sessionFile
    )
      throw new RpcError(-32602, "retry_source_unavailable");
    return {
      topic,
      isAddition,
      bot,
      message,
      run,
      sessionFile: run.sessionFile,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }
  async function plan(
    s: Source,
    scope: { primary: { path: string } },
    signal: AbortSignal,
    files: { managed: boolean },
  ) {
    const current = source(s),
      boundary = repo.boundary(s.messageId);
    const session = {
      sessionDir: join(dataDir, "bots", s.botId, "sessions"),
      sessionFile: resolveSessionFile(dataDir, boundary?.file ?? current.sessionFile),
      boundary: boundary?.entry,
      startedAt: current.startedAt,
      finishedAt: current.finishedAt,
      signal,
    };
    const inspected = await inspectRetrySession(session);
    const runs = repo.runsAfter(current.run.id, s.conversationId);
    const restores = [];
    const paths = new Set<string>();
    if (platform === "darwin")
      for (const run of runs) {
        const changes = new RunFileChangesRepo(db).summarize(run.id);
        if (!changes.length && !checkpoints.hasWriteToolEvidence(run.id)) continue;
        if (current.isAddition && run.id === current.run.id)
          throw new RpcError(-32602, "retry_files_unavailable");
        // Files changed in a folder Pi Bot cannot manage cannot be put back: refuse, as before.
        if (!files.managed) throw new RpcError(-32602, "retry_files_unavailable");
        if (
          !run.finishedAt ||
          changes.some((change) => change.kind === "command" || change.root !== scope.primary.path)
        )
          throw new RpcError(-32602, "retry_files_unavailable");
        const cp = checkpoints.forRun(run.id, scope.primary.path);
        if (
          !cp ||
          cp.botId !== s.botId ||
          cp.scopeKey !== `${target(s).conversationKey}|${run.conversationId}` ||
          cp.state !== "available" ||
          cp.truncated ||
          cp.items.some((item) => !item.restorable)
        )
          throw new RpcError(-32602, "retry_files_unavailable");
        // A historical restore receipt cannot prove that its target is still unchanged today.
        if (checkpoints.restoredPaths(cp.id).size)
          throw new RpcError(-32602, "retry_files_unavailable");
        const items = cp.items;
        for (const item of items) paths.add(item.path);
        if (items.length)
          restores.push({
            cp,
            items,
            target: { conversationKey: `dm:${s.botId}`, topicId: run.conversationId },
          });
      }
    const before = repo.messages(s.conversationId, s.messageId, "before"),
      after = repo.messages(s.conversationId, s.messageId, "after");
    if (paths.size > 500) throw new RpcError(-32602, "retry_files_limit");
    return {
      ...current,
      session,
      inspected,
      restores,
      before,
      fileCount: paths.size,
      restoreFiles: platform === "darwin" && files.managed,
      hash: hash([
        [s.botId, s.conversationId, s.messageId],
        inspected,
        current.topic.workplaceRevision,
        before.map((m) => [m.id, m.updatedAt]),
        after.map((m) => [m.id, m.updatedAt]),
        runs.map((r) => [r.id, r.status, r.finishedAt]),
        restores.map(({ cp, items }) => [cp.id, cp.version, items.map((i) => i.id)]),
      ]),
    };
  }
  return { repo, messages, conversations, target, source, plan };
}
