import { join } from "node:path";
import { readSessionRecovery, resolveSessionFile } from "@pibot/agent";
import {
  type ChatRecovery,
  CheckpointCaptureSchema,
  type KernelMethodParams,
  RpcError,
  recoverableChatRun,
} from "@pibot/protocol-base";
import {
  BotSessionsRepo,
  BotsRepo,
  ConversationsRepo,
  MessagesRepo,
  RunEventsRepo,
} from "@pibot/storage";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { continuationKey } from "../../runtime/continuation/continuation-keys.ts";

/** Current state only; no history, permission, filesystem, or task mutation is performed here. */
export async function inspectChatRecovery(
  service: GroupOrchestrationPort,
  params: KernelMethodParams["chat.recovery"],
): Promise<ChatRecovery> {
  const { botId, conversationId, runId } = params;
  const eventState = new RunEventsRepo(service.deps.db).state(runId),
    run = service.runs.get(runId),
    conversations = new ConversationsRepo(service.deps.db);
  const conversation = conversations.get(conversationId),
    bot = new BotsRepo(service.deps.db).get(botId);
  const message = run && new MessagesRepo(service.deps.db).get(run.messageId);
  if (
    !run ||
    !eventState?.created ||
    eventState.conversationId !== conversationId ||
    !eventState.terminal ||
    eventState.terminal.status !== run.status ||
    eventState.terminal.stopReason !== (run.stopReason ?? null) ||
    eventState.terminal.errorCode !== (run.errorCode ?? null) ||
    !conversation ||
    !bot ||
    bot.category === "image" ||
    bot.archivedAt ||
    conversation.archivedAt ||
    conversations.isInternal(conversationId) ||
    run.kind === "routine" ||
    run.botId !== botId ||
    run.conversationId !== conversationId ||
    !message ||
    message.runId !== runId ||
    message.botId !== botId ||
    message.conversationId !== conversationId
  )
    throw new RpcError(-32602, "Recovery source unavailable");
  const group = run.groupId ? service.active(run.groupId, botId, conversationId) : undefined;
  if (!group && (conversation.kind !== "dm" || conversation.botId !== botId || run.kind !== "chat"))
    throw new RpcError(-32602, "Invalid recovery conversation");
  const task = run.taskId ? service.tasks.get(run.taskId) : undefined;
  const taskThread = !!task && task.threadConversationId === conversationId;
  if (
    run.kind === "group_task" &&
    (!taskThread || task.groupId !== run.groupId || task.assigneeBotId !== botId)
  )
    throw new RpcError(-32602, "Recovery task scope changed");
  const busy = service.deps.chat.topicBusy(botId, conversationId);
  // Must match the retry key exactly: a receipt written by `runs.retry` is what "already requested"
  // means, and the key now carries the failed run's chain root.
  const receipt = service.runs.trigger(
    continuationKey(
      taskThread ? "group-task-retry" : "chat-model-recovery",
      service.deps.local.tasks.budgetRoot(run),
      runId,
    ),
  );
  const latest = !service.runs.hasRunAfter(runId);
  let continuation: ChatRecovery["continuation"] = receipt
    ? "already_requested"
    : busy
      ? "busy"
      : !latest
        ? "newer_run"
        : !recoverableChatRun(run) ||
            (run.taskId && !task) ||
            group?.paused ||
            (group && service.changing(group.id)) ||
            (group && run.cycleId !== service.cycles.get(group.id).cycleId) ||
            (task && (task.status !== "open" || service.tasks.hasPendingChildren(task.id)))
          ? "unavailable"
          : "ready";
  const session: ChatRecovery["session"] = {
    state: busy ? "busy" : "missing",
    entryCount: 0,
    checkpoint: null,
  };
  // A group task owns its run file even if a legacy topic pointer still exists for this thread.
  const stored =
    run.groupId && run.taskId
      ? run.sessionFile
      : (new BotSessionsRepo(service.deps.db).get(botId, conversationId) ??
        (conversation.kind === "dm" ? conversation.piSessionFile : undefined) ??
        run.sessionFile);
  const capture = CheckpointCaptureSchema.safeParse(
    message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
      ? message.usage.fileCheckpoint
      : undefined,
  );
  const history = service.runs.list({ botId, conversationId }, { limit: 21 });
  const emptyHistory =
    history.length < 21 &&
    history.every((prior) => {
      const reply = new MessagesRepo(service.deps.db).get(prior.messageId);
      const usage = reply?.usage;
      const priorCapture = CheckpointCaptureSchema.safeParse(
        usage && typeof usage === "object" && !Array.isArray(usage)
          ? usage.fileCheckpoint
          : undefined,
      );
      return (
        !!reply &&
        !reply.content.trim() &&
        !reply.tools?.length &&
        !priorCapture.success &&
        prior.status === "error" &&
        ["auth_failed", "quota_exhausted", "billing", "no_model"].includes(prior.errorCode ?? "")
      );
    });
  const emptyStart =
    (history.length === 1 || emptyHistory) &&
    !message.content.trim() &&
    !message.tools?.length &&
    !capture.success &&
    !new MessagesRepo(service.deps.db).hasRecoveryHistory(botId, conversationId);
  if (!busy && stored) {
    try {
      const inspected = await readSessionRecovery({
        sessionDir: join(service.deps.dataDir, "bots", botId, "sessions"),
        sessionFile: resolveSessionFile(service.deps.dataDir, stored),
        signal: service.signal,
      });
      Object.assign(
        session,
        { entryCount: inspected.entryCount, checkpoint: inspected.checkpoint },
        { state: "available" },
      );
    } catch (cause) {
      service.signal.throwIfAborted();
      // Invalid, changing, missing, or unsupported JSONL cannot prove a safe continuation state.
      session.state =
        emptyStart && cause instanceof Error && "code" in cause && cause.code === "ENOENT"
          ? "missing"
          : "unavailable";
    }
  }
  // A first credential failure can occur before any session exists. A registered but unreadable
  // file is different: its history cannot safely be replaced with an empty session.
  if (
    continuation === "ready" &&
    session.state !== "available" &&
    !(session.state === "missing" && emptyStart)
  )
    continuation = "unavailable";
  return {
    run: {
      id: run.id,
      status: run.status,
      errorCode: message.errorCode,
      finishedAt: run.finishedAt,
    },
    task: task
      ? { id: task.id, title: service.deps.redactor.redact(task.title), status: task.status }
      : null,
    session,
    fileCheckpoint: capture.success ? capture.data : null,
    continuation,
  };
}
