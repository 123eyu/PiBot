import { FILE_LIMIT, fileMime, MAX_ATTACHMENTS } from "@pibot/protocol";
import { File } from "expo-file-system";
import type { ShareIntent } from "expo-share-intent";
import type { PendingFile } from "../../transport/link-port.ts";
import { encodeJpeg } from "../phone-data/jpeg-native.ts";
import { nativeShareFiles } from "./share-files-native.ts";
import { MESSAGE_FILE_BYTES } from "./upload.ts";

// Images are re-encoded as JPEG: HEIC and huge camera files become a size the computer accepts
// (its own limit is 10 MB), and the original's EXIF location never leaves the phone.
const IMAGE_EDGE = 2560;
const IMAGE_BYTES = 8 * 1024 * 1024;
const safeName = (name: string) =>
  name.replace(/[\\/\p{Cc}\p{Cf}]/gu, "_").slice(0, 200) || "shared";

/** A file handed over by the share sheet, a picker or the camera, before it is prepared. */
export interface SourceFile {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
}
/** What one message can still take: files and raw bytes. */
export interface Room {
  count: number;
  bytes: number;
}
export const MESSAGE_ROOM: Room = { count: MAX_ATTACHMENTS, bytes: MESSAGE_FILE_BYTES };

/** What the share sheet handed over, as message text plus files copied into the share store. */
export function sharedText(intent: ShareIntent) {
  const text = intent.text?.trim() ?? "";
  if (intent.webUrl && !text.includes(intent.webUrl))
    return [text, intent.webUrl].filter(Boolean).join("\n");
  return text;
}
export function prepareShared(intent: ShareIntent) {
  return prepareFiles(
    (intent.files ?? []).map((shared) => ({
      uri: shared.path,
      name: shared.fileName,
      mimeType: shared.mimeType,
      size: shared.size ?? undefined,
      width: shared.width ?? undefined,
      height: shared.height ?? undefined,
    })),
    MESSAGE_ROOM,
  );
}
async function prepareImage(source: SourceFile): Promise<PendingFile> {
  const jpeg = await encodeJpeg(
    source.uri,
    { width: source.width ?? 0, height: source.height ?? 0 },
    { maxEdge: IMAGE_EDGE, maxBytes: IMAGE_BYTES },
    false,
  );
  try {
    const copy = await nativeShareFiles.importFile(jpeg.uri);
    const base = safeName(source.name).replace(/\.[^.]*$/, "");
    return { kind: "image", name: `${base}.jpg`, mimeType: "image/jpeg", ...copy };
  } finally {
    // The encoder's output sits in the cache directory; the share store has the copy now.
    const temp = new File(jpeg.uri);
    if (temp.exists) temp.delete();
  }
}
/**
 * Copies files into the share store as the computer accepts them: images as JPEG, other files
 * by the desktop's supported types and size limit, within `room` (count and bytes). Everything
 * else is skipped and counted, never an error, so the rest still go.
 */
export async function prepareFiles(sources: SourceFile[], room: Room) {
  const files: PendingFile[] = [];
  let skipped = 0,
    bytes = 0;
  for (const source of sources) {
    if (files.length >= room.count) {
      skipped++;
      continue;
    }
    try {
      let file: PendingFile;
      if (source.mimeType?.startsWith("image/")) file = await prepareImage(source);
      else {
        const name = safeName(source.name);
        const mimeType = fileMime(name);
        if (!mimeType || (source.size ?? 0) > Math.min(FILE_LIMIT, room.bytes - bytes)) {
          skipped++;
          continue;
        }
        file = { kind: "file", name, mimeType, ...(await nativeShareFiles.importFile(source.uri)) };
        if (file.bytes > FILE_LIMIT || file.bytes === 0) {
          nativeShareFiles.remove(file.blob);
          skipped++;
          continue;
        }
      }
      if (bytes + file.bytes > room.bytes) {
        nativeShareFiles.remove(file.blob);
        skipped++;
        continue;
      }
      bytes += file.bytes;
      files.push(file);
    } catch {
      // An unreadable or undecodable file is skipped and counted; the rest still go.
      skipped++;
    }
  }
  return { files, skipped };
}
/** Drops copies of a share or draft that was cancelled or refused before reaching the outbox. */
export function discardShared(files: readonly PendingFile[]) {
  for (const file of files) nativeShareFiles.remove(file.blob);
}
