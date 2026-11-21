import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ExactStatIdentity, sameFile } from "@pibot/execution/file-identity";
import type { Logger } from "@pibot/observability";
import { createRedactor } from "@pibot/secrets";
import { StartupSnapshotSchema } from "../../shared/startup-snapshot.ts";

const MAX_BYTES = 512 * 1024;
/** GUI-only display data. Clear fences queued writes for the rest of this process. */
export function createStartupSnapshotStore(directory: string, logger: Pick<Logger, "warn">) {
  const file = join(directory, "startup-display.json");
  const redactor = createRedactor();
  let cleared = false;
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(action: () => Promise<T>) => {
    const job = tail.then(action);
    tail = job.catch(() => {}); // Each caller receives its failure; later cleanup still runs.
    return job;
  };
  const inspectDirectory = async () => {
    // Exact bigint identity: NTFS IDs exceed a double, so a neighbouring folder could pass.
    const info = await lstat(directory, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)) !== resolve(directory)
    )
      throw new Error("startup_cache_directory_changed");
    return { dev: info.dev, ino: info.ino };
  };
  let identity: ExactStatIdentity | undefined;
  const initial = inspectDirectory().then(
    (info) => {
      identity = info;
    },
    (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    },
  );
  void initial.catch(() => {}); // Operations report validation failures; initialization never hides them.
  const checkDirectory = async () => {
    await initial;
    const info = await inspectDirectory();
    if (identity && !sameFile(identity, info)) throw new Error("startup_cache_directory_changed");
    identity ??= info;
  };
  const removeOwnedFile = async (path: string) => {
    await checkDirectory();
    await rm(path, { force: true });
  };
  return {
    async read() {
      if (cleared) return null;
      try {
        await checkDirectory();
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) return null;
          if (process.platform !== "win32" && (info.mode & 0o077) !== 0) return null;
          const bytes = Buffer.alloc(MAX_BYTES + 1);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          if (bytesRead > MAX_BYTES || cleared) return null;
          return StartupSnapshotSchema.parse(
            JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
          );
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          logger.warn("Startup display cache unavailable");
        return null;
      }
    },
    save(value: unknown) {
      const parsed = StartupSnapshotSchema.parse(value);
      return enqueue(async () => {
        if (cleared) return;
        // RPC display projections contain no credentials; redact pattern secrets again before disk.
        const text = JSON.stringify(parsed, (_key, value: unknown) =>
          typeof value === "string" ? redactor.redact(value) : value,
        );
        if (Buffer.byteLength(text) > MAX_BYTES) return;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await checkDirectory();
        const temporary = join(directory, `startup-display-${randomUUID()}.tmp`);
        try {
          await open(temporary, "wx", 0o600).then(async (handle) => {
            try {
              await handle.writeFile(text);
            } finally {
              await handle.close();
            }
          });
          await checkDirectory();
          if (!cleared) await rename(temporary, file);
        } finally {
          await removeOwnedFile(temporary);
        }
      });
    },
    clear() {
      cleared = true;
      return enqueue(async () => {
        try {
          await removeOwnedFile(file);
          await checkDirectory();
          const entries = await opendir(directory);
          let count = 0;
          for await (const entry of entries) {
            if (++count > 128) throw new Error("startup_cache_cleanup_limit");
            // A crash may leave an unpublished private file. Never remove other GUI data.
            if (entry.isFile() && /^startup-display-[a-f0-9-]{36}\.tmp$/.test(entry.name))
              await removeOwnedFile(join(directory, entry.name));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      });
    },
  };
}
