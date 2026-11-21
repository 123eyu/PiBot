import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { AttachmentsRepo, BotsRepo, ConversationsRepo, MessagesRepo } from "@pibot/storage";
import { attachmentDirectory, attachmentFile } from "./attachment-files.ts";

/** GUI read authority is a persisted message attachment, never a renderer-supplied path. */
export async function attachmentSource(
  db: DatabaseSync,
  dataDir: string,
  input: { attachmentId: string; messageId: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const attachments = new AttachmentsRepo(db);
  const message = new MessagesRepo(db).get(input.messageId);
  if (
    !message ||
    !["user", "assistant"].includes(message.role) ||
    // send_file persists an attachment only after its copy is complete, so an assistant reply's
    // attachments are final while the reply still streams; previewing waited for the whole run.
    (message.status === "streaming" && message.role !== "assistant") ||
    new ConversationsRepo(db).isInternal(message.conversationId) ||
    !attachments
      .forMessages([message.id])
      .get(message.id)
      ?.some((item) => item.id === input.attachmentId)
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "preview_unavailable");
  const stored = attachments.get(input.attachmentId);
  if (!stored || !new BotsRepo(db).get(stored.botId))
    throw new RpcError(RpcErrorCodes.invalidParams, "preview_unavailable");
  const root = await attachmentDirectory(dataDir, stored.botId);
  const path = await attachmentFile(dataDir, stored.path);
  if (dirname(path) !== root || path !== join(root, basename(path)))
    throw new RpcError(RpcErrorCodes.invalidParams, "preview_unavailable");
  signal.throwIfAborted();
  return { stored, root, path };
}
