import { PREVIEW_DATA_CHUNK } from "@pibot/protocol";
import type { LinkConnection, PendingFile } from "../../transport/link-port.ts";

/**
 * Files shared into Pi Bot or attached in a chat's composer, kept in app storage until their
 * message is sent.
 */
export interface ShareFiles {
  /** Standard base64 of `length` bytes from `offset`. */
  read(blob: string, offset: number, length: number): Promise<string>;
  remove(blob: string): void;
  /** A local URI for thumbnails in the composer and on pending bubbles; absent in probes. */
  uri?(blob: string): string;
  /** Blobs last written more than `ms` ago: leftovers of a draft or share the app was killed with. */
  stale?(ms: number): string[];
}
/** Raw bytes per slice: exactly one gateway slice of base64 (a multiple of 3, so slices join). */
export const SHARE_SLICE_BYTES = (PREVIEW_DATA_CHUNK / 4) * 3;
/**
 * One message's files, raw bytes. The gateway holds a phone session's unsent uploads in memory
 * within 48 MiB of base64 (packages/remote rpc/share-uploads.ts), i.e. 36 MiB raw; a message
 * must fit with room to spare or it could never be sent.
 */
export const MESSAGE_FILE_BYTES = 32 * 1024 * 1024;
/** All files waiting in the phone's outboxes: bounded app storage while offline. */
export const PENDING_FILE_BYTES = 100 * 1024 * 1024;

/** Uploads one file slice by slice over the session; returns the attachment ID for chat.send. */
export async function uploadShared(
  connection: Pick<LinkConnection, "uploadChunk">,
  files: ShareFiles,
  file: PendingFile,
  signal: AbortSignal,
  /** Raw bytes of this file the computer has confirmed so far. */
  onProgress?: (bytes: number) => void,
) {
  const total = Math.ceil(file.bytes / 3) * 4;
  let uploadId: string | undefined;
  for (let at = 0; at < file.bytes; at += SHARE_SLICE_BYTES) {
    signal.throwIfAborted();
    const length = Math.min(SHARE_SLICE_BYTES, file.bytes - at);
    const chunk = await files.read(file.blob, at, length);
    const receipt = await connection.uploadChunk(
      {
        ...(uploadId ? { uploadId } : {}),
        kind: file.kind,
        name: file.name,
        mimeType: file.mimeType,
        total,
        offset: (at / 3) * 4,
        chunk,
      },
      signal,
    );
    uploadId = receipt.uploadId;
    onProgress?.(at + length);
    if (receipt.attachmentId) return receipt.attachmentId;
  }
  throw new Error("share_upload_incomplete");
}
