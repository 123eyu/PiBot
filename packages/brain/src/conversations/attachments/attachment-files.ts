import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IMAGE_LIMIT, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { resolveAttachmentPath } from "@pibot/storage";
import { imageDimensions } from "./image-dimensions.ts";

export function invalidAttachment(): never {
  throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachment_invalid");
}
export function imageMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return invalidAttachment();
}
export async function attachmentDirectory(dataDir: string, botId: string) {
  const root = join(await realpath(dataDir), "bots", botId, "attachments");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await realpath(root)) !== resolve(root)) invalidAttachment();
  return root;
}
/**
 * Absolute file for a stored attachment path. `realDataDir` is the realpath'd data root, so the
 * result is spelled like `attachmentDirectory()`; containment is still checked by the caller.
 */
export function storedAttachmentFile(realDataDir: string, stored: string): string {
  try {
    return resolveAttachmentPath(realDataDir, stored);
  } catch (error) {
    // A malformed stored value is corrupt metadata, reported like any other unusable attachment.
    if (error instanceof TypeError) invalidAttachment();
    throw error;
  }
}
export async function attachmentFile(dataDir: string, stored: string): Promise<string> {
  return storedAttachmentFile(await realpath(dataDir), stored);
}
export async function readOwnedFile(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (resolve(dirname(path)) !== resolve(root) || (await realpath(path)) !== resolve(path))
    invalidAttachment();
  return readFile(path, { signal });
}
export async function saveFile(path: string, data: string | Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  await writeFile(path, data, { flag: "wx", mode: 0o600, signal });
}
export async function discardFiles(paths: string[]) {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}
export function checkedImage(data: string, declared: string): Buffer {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > IMAGE_LIMIT || imageMime(bytes) !== declared) invalidAttachment();
  const dimensions = imageDimensions(bytes, declared);
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > 16384 ||
    dimensions.height > 16384 ||
    dimensions.width * dimensions.height > 40_000_000
  )
    invalidAttachment();
  return bytes;
}
