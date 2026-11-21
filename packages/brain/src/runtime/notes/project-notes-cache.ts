import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileIdentityKey } from "@pibot/execution";
import { abortable } from "../../core/abort.ts";

interface CachedNotes {
  version: string;
  path: string;
  prompt: string;
}
/** Text is already redacted; entries are data, never authorization receipts. */
export class ProjectNotesCache {
  private readonly entries = new Map<string, CachedNotes>();
  get(key: string, version: string): CachedNotes | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.version !== version) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }
  set(key: string, entry: CachedNotes) {
    this.entries.delete(key);
    while (this.entries.size >= 64) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }
  clear() {
    this.entries.clear();
  }
}
/** Per-file metadata is only a cache version; fresh policy still authorizes every reuse. */
export async function projectNotesVersion(
  root: string,
  signal: AbortSignal,
  name?: "AGENTS.md" | "CLAUDE.md",
): Promise<string | undefined> {
  const files = [];
  for (const fileName of name ? [name] : ["AGENTS.md", "CLAUDE.md"]) {
    signal.throwIfAborted();
    try {
      const stat = await abortable(
        lstat(join(root, fileName), { bigint: true }),
        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      );
      // Exact identity and times; the version is compared as a string, never as numbers.
      files.push([
        fileName,
        fileIdentityKey(stat),
        String(stat.mode),
        String(stat.nlink),
        String(stat.size),
        String(stat.mtimeNs),
        String(stat.ctimeNs),
      ]);
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR"].includes(String(error.code))
      )
        files.push([fileName, "absent"]);
      else if (
        error instanceof Error &&
        "code" in error &&
        ["EACCES", "EPERM", "ELOOP"].includes(String(error.code))
      )
        return undefined;
      else throw error;
    }
  }
  return JSON.stringify(files);
}
