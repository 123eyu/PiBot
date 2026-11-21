import { Directory, File, Paths } from "expo-file-system";
import type { BlobFiles } from "./file-cache.ts";

// The app's cache directory is private to the app, excluded from backups, and may be purged by
// the OS under storage pressure; the cache index treats a missing blob as a miss.
const ROOT = "pibot-files";
const file = (name: string) => new File(Paths.cache, ROOT, ...name.split("/"));

export const nativeBlobFiles: BlobFiles = {
  async append(name, chunk, encoding) {
    const target = file(name);
    if (!target.exists) {
      const [folder] = name.split("/");
      new Directory(Paths.cache, ROOT, folder as string).create({
        intermediates: true,
        idempotent: true,
      });
      target.create();
    }
    await target.write(chunk, { encoding, append: true });
  },
  readText: (name) => file(name).text(),
  uri: (name) => file(name).uri,
  size(name) {
    const target = file(name);
    return target.exists ? target.size : null;
  },
  remove(name) {
    const target = file(name);
    if (target.exists) target.delete();
  },
  removeFolder(folder) {
    const target = new Directory(Paths.cache, ROOT, folder);
    if (target.exists) target.delete();
  },
};
