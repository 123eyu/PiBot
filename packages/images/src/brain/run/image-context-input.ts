import { AgentError } from "@pibot/agent";
import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import { activeGroup, readManagedImage, visibleGroupMessage } from "@pibot/brain/kit";
import {
  type ImageContent,
  type Message,
  RpcError,
  RpcErrorCodes,
} from "@pibot/images-contract/full";
import {
  AttachmentsRepo,
  BotsRepo,
  ConversationsRepo,
  ImageArtifactsRepo,
  ImageContextRepo,
  MessagesRepo,
  RunsRepo,
} from "@pibot/storage";

/** Only the nearest visible image message in this topic becomes an implicit edit reference. */
export async function imageContextInputs(
  local: LocalService,
  context: ToolRunContext,
  explicit: ImageContent[],
): Promise<{ images: ImageContent[]; assertCurrent(): void }> {
  if (explicit.length || context.routineRunId)
    return { images: explicit, assertCurrent: () => context.signal.throwIfAborted() };
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]);
  const db = local.deps.db,
    messages = new MessagesRepo(db),
    repo = new AttachmentsRepo(db);
  const run = new RunsRepo(db).get(context.runId);
  if (
    !run ||
    run.botId !== context.botId ||
    run.conversationId !== context.conversationId ||
    run.messageId !== context.messageId ||
    run.status !== "running"
  )
    throw new AgentError("permission_denied");
  const scope = () => {
    context.signal.throwIfAborted();
    const bot = new BotsRepo(db).get(context.botId),
      conversation = new ConversationsRepo(db).get(run.conversationId);
    if (!bot || bot.archivedAt || !conversation || conversation.archivedAt)
      throw new AgentError("permission_denied");
    if (context.groupId) return activeGroup(db, context.groupId, context.botId, run.conversationId);
    if (conversation.kind !== "dm" || conversation.botId !== context.botId)
      throw new AgentError("permission_denied");
  };
  scope();
  const history = new ImageContextRepo(db).before(
    run.conversationId,
    run.userMessageId ?? context.messageId,
  );
  const visible = (message: Message) => {
    const group = scope();
    return group
      ? visibleGroupMessage(db, group, message)
      : message.status === "done" ||
          (!!message.usage &&
            typeof message.usage === "object" &&
            !Array.isArray(message.usage) &&
            message.usage.imageGeneration === true &&
            !!message.runId &&
            !!new ImageArtifactsRepo(db).get(message.runId)?.generatedAt &&
            !!message.attachments?.length);
  };
  const source = history.find((m) => m.attachments?.some((a) => a.kind === "image") && visible(m));
  if (!source)
    return {
      images: [],
      assertCurrent: () => {
        scope();
      },
    };
  const authorized = (id: string) => {
    context.signal.throwIfAborted();
    const message = messages.get(source.id),
      attachment = repo.get(id),
      group = scope();
    if (
      !message ||
      message.conversationId !== run.conversationId ||
      !visible(message) ||
      !message.attachments?.some((a) => a.id === id && a.kind === "image") ||
      !attachment ||
      (group
        ? repo.groupId(id) !== group.id || !group.members.some((m) => m.botId === attachment.botId)
        : attachment.botId !== context.botId)
    )
      throw new AgentError("context_unavailable");
    return attachment;
  };
  const result: ImageContent[] = [];
  let remaining = 20 * 1024 * 1024;
  const selected = (source.attachments ?? []).filter((a) => a.kind === "image").slice(0, 5);
  for (const metadata of selected) {
    signal.throwIfAborted();
    const before = authorized(metadata.id);
    if (metadata.size > remaining) throw new AgentError("context_too_large");
    const loaded = await readManagedImage(local.deps, metadata.id, signal).catch(
      (error: unknown) => {
        signal.throwIfAborted();
        if (
          (error instanceof RpcError && error.code === RpcErrorCodes.attachmentInvalid) ||
          (error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code)))
        )
          throw new AgentError("context_unavailable");
        throw error;
      },
    );
    signal.throwIfAborted();
    const after = authorized(metadata.id);
    if (
      before.path !== after.path ||
      before.messageId !== after.messageId ||
      before.botId !== after.botId ||
      loaded.bytes.length > remaining
    )
      throw new AgentError("context_unavailable");
    result.push(loaded.image);
    remaining -= loaded.bytes.length;
  }
  return {
    images: result,
    assertCurrent: () => {
      for (const metadata of selected) authorized(metadata.id);
    },
  };
}
