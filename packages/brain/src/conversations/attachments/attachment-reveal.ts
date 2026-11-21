import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { imageExportFileName, matchesFileIdentity } from "@pibot/execution";
import { type KernelMethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { AttachmentsRepo, ImageArtifactsRepo, MessagesRepo } from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import type { LocalDependencies } from "../../core/local-types.ts";
import { attachmentFile, invalidAttachment } from "./attachment-files.ts";

/** Only persisted message attachment identities reach the OS, never renderer-supplied paths. */
export async function revealAttachment(
  deps: Pick<LocalDependencies, "db" | "dataDir" | "host">,
  { id, messageId }: KernelMethodParams["chat.revealAttachment"],
  signal: AbortSignal,
) {
  const attachments = new AttachmentsRepo(deps.db),
    messages = new MessagesRepo(deps.db);
  const attachment = attachments.get(id),
    message = messages.get(messageId);
  if (
    !message ||
    !attachment ||
    !attachments
      .forMessages([messageId])
      .get(messageId)
      ?.some((item) => item.id === id)
  )
    invalidAttachment();
  const show = deps.host.revealPath;
  if (!show) throw new RpcError(RpcErrorCodes.unsupported, "attachment_reveal_unsupported");
  const root = join(await realpath(deps.dataDir), "bots", attachment.botId, "attachments");
  let path = await attachmentFile(deps.dataDir, attachment.path),
    allowedRoot = root;
  // Prefer a generated image's saved workspace copy only while its durable write receipt matches.
  const original = messages.get(attachment.messageId);
  const artifacts = new ImageArtifactsRepo(deps.db);
  const record = original?.runId ? artifacts.get(original.runId) : undefined;
  if (
    attachment.metadata.kind === "image" &&
    record?.generatedAt &&
    record.target.source.messageId === attachment.messageId &&
    record.target.source.botId === attachment.botId
  ) {
    const extensions: Record<string, "png" | "jpg" | "gif" | "webp"> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
    };
    const extension = extensions[attachment.metadata.mimeType];
    if (extension) {
      const saved = join(
        record.target.cwd,
        imageExportFileName({
          runId: record.target.source.runId,
          attachmentId: id,
          extension,
        }),
      );
      const receipt = artifacts.receiptGet(
        JSON.stringify([attachment.botId, record.target.source.runId, id, saved]),
      );
      if (receipt) {
        try {
          // Receipts store execution's canonical (exact) identity spelling.
          const file = await lstat(saved, { bigint: true }),
            parent = await lstat(dirname(saved), { bigint: true });
          if (
            file.isFile() &&
            !file.isSymbolicLink() &&
            file.nlink === 1n &&
            matchesFileIdentity(file, receipt) &&
            matchesFileIdentity(parent, {
              device: receipt.parentDevice,
              inode: receipt.parentInode,
            }) &&
            (await realpath(saved)) === saved &&
            (await realpath(dirname(saved))) === dirname(saved)
          ) {
            path = saved;
            allowedRoot = dirname(saved);
          }
        } catch (error) {
          // A removed workspace copy still has the original managed attachment available.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  if (
    allowedRoot === root &&
    (resolve(dirname(path)) !== root ||
      (await realpath(root)) !== root ||
      (await realpath(path)) !== resolve(path) ||
      !(await lstat(path)).isFile())
  )
    invalidAttachment();
  if ((await lstat(path)).nlink !== 1) invalidAttachment();
  signal.throwIfAborted();
  // History may be deleted while filesystem checks are pending.
  if (
    !messages.get(messageId) ||
    !attachments
      .forMessages([messageId])
      .get(messageId)
      ?.some((a) => a.id === id)
  )
    invalidAttachment();
  await abortable(show({ path, allowedRoots: [allowedRoot] }, signal), signal);
  return { ok: true as const };
}
