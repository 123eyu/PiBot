import { Directory, File, FileMode, Paths } from "expo-file-system";
import { toBase64 } from "../../storage/base64.ts";
import type { ShareFiles } from "./upload.ts";

// Documents, not caches: a message waiting in the outbox must not lose its file to the OS
// purging caches. Removed after the send, on unpair, when the share or draft is dropped, and as
// stale leftovers at startup (`MobileStorage.sweepShare`).
const ROOT = "pibot-share";
const file = (blob: string) => new File(Paths.document, ROOT, blob);

export const nativeShareFiles: ShareFiles & {
  /** Copies a shared or prepared file into the share store. */
  importFile(uri: string): Promise<{ blob: string; bytes: number }>;
} = {
  async importFile(uri) {
    new Directory(Paths.document, ROOT).create({ intermediates: true, idempotent: true });
    const blob = crypto.randomUUID();
    const target = file(blob);
    await new File(uri).copy(target);
    return { blob, bytes: target.size ?? 0 };
  },
  async read(blob, offset, length) {
    const handle = file(blob).open(FileMode.ReadOnly);
    try {
      handle.offset = offset;
      return toBase64(await handle.readBytes(length));
    } finally {
      handle.close();
    }
  },
  remove(blob) {
    const target = file(blob);
    if (target.exists) target.delete();
  },
  uri: (blob) => file(blob).uri,
  stale(ms) {
    const root = new Directory(Paths.document, ROOT);
    if (!root.exists) return [];
    const before = Date.now() - ms;
    return root
      .list()
      .filter(
        (entry): entry is File => entry instanceof File && (entry.modificationTime ?? 0) < before,
      )
      .map((entry) => entry.name);
  },
};
