import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RoutineLedgerFile } from "@pibot/protocol";

// Bounds keep a manifest cheap to build and small to store: a period folder is a report or a few
// tables, not a data dump. Larger files are listed with size only.
const MAX_FILES = 200;
const MAX_DEPTH = 4;
const MAX_HASH_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 128 * 1024 * 1024;

const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes(String((error as { code?: unknown } | null)?.code));

/** A real directory at exactly this path (no link anywhere on the way), or undefined. */
export async function realDirectory(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    const canonical = await realpath(path);
    return canonical === resolve(path) ? canonical : undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function sha256(path: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Regular files at these paths, skipping links and anything gone since. With `hash`, files up to
 * 32 MB get a SHA-256 while the total stays under 128 MB; the rest keep size and time only.
 */
export async function fileFacts(paths: string[], hash: boolean, signal: AbortSignal) {
  const files: RoutineLedgerFile[] = [];
  let hashed = 0;
  for (const path of paths.slice(0, MAX_FILES)) {
    signal.throwIfAborted();
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (!info.isFile()) continue;
    const size = Number(info.size);
    const digest =
      hash && size <= MAX_HASH_BYTES && hashed + size <= MAX_TOTAL_HASH_BYTES
        ? await sha256(path, signal).catch((error: unknown) => {
            if (missing(error)) return null;
            throw error;
          })
        : null;
    if (digest) hashed += size;
    files.push({ path, size, sha256: digest, mtimeMs: Math.max(0, Number(info.mtimeMs)) });
  }
  return files;
}

/** Regular files under a real directory, breadth first, bounded in count and depth; links skipped. */
export async function listFiles(root: string, signal: AbortSignal) {
  const found: string[] = [];
  let level = [root];
  for (let depth = 0; depth < MAX_DEPTH && level.length && found.length < MAX_FILES; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      signal.throwIfAborted();
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        // Pi Bot's own atomic-write temp files are never deliverables.
        if (entry.name.startsWith(".pibot-")) continue;
        const path = join(dir, entry.name);
        if (entry.isFile()) found.push(path);
        else if (entry.isDirectory()) next.push(path);
        if (found.length >= MAX_FILES) break;
      }
      if (found.length >= MAX_FILES) break;
    }
    level = next;
  }
  return found;
}
