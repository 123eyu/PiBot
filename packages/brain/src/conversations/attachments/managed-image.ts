import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sameFile } from "@pibot/execution";
import { IdSchema, IMAGE_LIMIT, type ImageContent, ImageContentSchema } from "@pibot/protocol-base";
import { AttachmentsRepo, type StoredAttachment } from "@pibot/storage";
import { checkedImage, invalidAttachment, storedAttachmentFile } from "./attachment-files.ts";
import { imageDimensions } from "./image-dimensions.ts";

/** Storage integrity only. Callers must separately authorize the live run/message/group before and after IO. */
export async function readManagedImage(
  deps: { db: DatabaseSync; dataDir: string },
  attachmentId: string,
  signal: AbortSignal,
): Promise<{ attachment: StoredAttachment; image: ImageContent; bytes: Buffer }> {
  signal.throwIfAborted();
  const repo = new AttachmentsRepo(deps.db),
    attachment = repo.get(attachmentId);
  if (attachment?.metadata.kind !== "image") invalidAttachment();
  const metadata = attachment.metadata;
  const botId = IdSchema.parse(attachment.botId);
  const real = await realpath(deps.dataDir);
  const root = join(real, "bots", botId, "attachments");
  const filePath = storedAttachmentFile(real, attachment.path);
  if (
    resolve(dirname(filePath)) !== resolve(root) ||
    !basename(filePath).startsWith(`${attachmentId}.`) ||
    (await realpath(root)) !== resolve(root) ||
    (await realpath(filePath)) !== resolve(filePath)
  )
    invalidAttachment();
  // Exact (bigint) identities: number stats round NTFS file IDs and can alias two files.
  const rootBefore = await lstat(root, { bigint: true }),
    before = await lstat(filePath, { bigint: true });
  if (
    !rootBefore.isDirectory() ||
    !before.isFile() ||
    // Managed caches have one physical owner; hard links could let another path mutate their bytes.
    before.nlink !== 1n ||
    Number(before.size) !== metadata.size ||
    Number(before.size) > IMAGE_LIMIT
  )
    invalidAttachment();
  // A regular file can be replaced by a FIFO between lstat and open; never wait for its writer.
  const file = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const buffer = Buffer.alloc(Number(before.size) + 1);
  let size = 0;
  try {
    const opened = await file.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameFile(opened, before) ||
      opened.size !== before.size
    )
      invalidAttachment();
    // readFile can allocate arbitrarily if a file grows after stat. Bound allocation and every read instead.
    while (size < buffer.length) {
      signal.throwIfAborted();
      const read = await file.read(buffer, size, Math.min(64 * 1024, buffer.length - size), size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      size !== Number(before.size) ||
      !after.isFile() ||
      after.nlink !== 1n ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    )
      invalidAttachment();
  } finally {
    await file.close();
  }
  signal.throwIfAborted();
  const rootAfter = await lstat(root, { bigint: true }),
    after = await lstat(filePath, { bigint: true }),
    fresh = repo.get(attachmentId);
  if (
    !sameFile(rootBefore, rootAfter) ||
    !sameFile(before, after) ||
    !after.isFile() ||
    after.nlink !== 1n ||
    (await realpath(root)) !== resolve(root) ||
    (await realpath(filePath)) !== resolve(filePath) ||
    !fresh ||
    fresh.botId !== attachment.botId ||
    fresh.path !== attachment.path ||
    fresh.messageId !== attachment.messageId ||
    JSON.stringify(fresh.metadata) !== JSON.stringify(metadata)
  )
    invalidAttachment();
  const bytes = buffer.subarray(0, size);
  const image = ImageContentSchema.parse({
    type: "image",
    mimeType: metadata.mimeType,
    data: bytes.toString("base64"),
  });
  checkedImage(image.data, image.mimeType);
  const dimensions = imageDimensions(bytes, image.mimeType);
  if (dimensions?.width !== metadata.width || dimensions?.height !== metadata.height)
    invalidAttachment();
  signal.throwIfAborted();
  return { attachment: fresh, image, bytes };
}
