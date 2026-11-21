import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IdSchema, RoutineDevControlSchema } from "@pibot/protocol";
import { z } from "zod";
import type { createRoutineHost } from "../control.ts";

async function openRegular(path: string) {
  // Windows may not implement O_NOFOLLOW; verify both path and opened identity as well.
  // Bigint stats keep NTFS-sized inodes exact (see execution core/file-identity.ts).
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new Error("invalid_dev_file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino
    )
      throw new Error("dev_file_identity_changed");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function boundedText(file: Awaited<ReturnType<typeof open>>, limit: number) {
  const bytes = Buffer.alloc(limit + 1);
  const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
  if (bytesRead > limit) throw new Error("dev_file_too_large");
  return bytes.subarray(0, bytesRead).toString("utf8");
}

// Explicit marker and canonical isolation are required even in the serve-only build.
export async function routineTestDirectory(directory: string, requested: string, normal: string) {
  const root = await realpath(directory);
  const normalRoot = await realpath(normal).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return resolve(normal);
    throw error;
  });
  if (root !== (await realpath(requested)) || root === normalRoot)
    throw new Error("routine_test_isolation_required");
  const handle = await openRegular(join(root, ".pibot-routine-test"));
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 64 ||
      stat.nlink !== 1 ||
      (await boundedText(handle, 64)).trim() !== "PIBOT_ROUTINE_TEST_ONLY"
    )
      throw new Error("routine_test_marker_required");
  } finally {
    await handle.close();
  }
  return root;
}
export function registerRoutineDev(options: {
  directory: string;
  host: ReturnType<typeof createRoutineHost>;
  send(control: z.infer<typeof RoutineDevControlSchema>): void;
  failed(): void;
}) {
  const input = join(options.directory, ".pibot-routine-control.json");
  const output = join(options.directory, ".pibot-routine-result.json");
  let closed = false,
    lastId: string | undefined;
  let acknowledgedId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let lastFailureAt = -Infinity;
  const failed = () => {
    if (performance.now() - lastFailureAt >= 5000) {
      lastFailureAt = performance.now();
      options.failed();
    }
  };
  async function check() {
    let id: string | undefined;
    try {
      if ((await realpath(options.directory)) !== options.directory)
        throw new Error("test_directory_changed");
      const file = await openRegular(input);
      let text: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384)
          throw new Error("invalid_dev_file");
        text = await boundedText(file, 16384);
      } finally {
        await file.close();
      }
      if (closed) return;
      const value = z
        .strictObject({ id: IdSchema, control: RoutineDevControlSchema })
        .parse(JSON.parse(text));
      id = value.id;
      if (id === acknowledgedId) return;
      if (id !== lastId) {
        if (value.control.type === "dev-power")
          options.host.simulateSupply(
            value.control.supply,
            value.control.event === "resume" || value.control.event === "suspend"
              ? value.control.event
              : undefined,
          );
        if (
          value.control.type === "dev-routine-timing" &&
          value.control.patch.waitingKeepAwakeMs !== undefined
        )
          options.host.simulateTiming(value.control.patch.waitingKeepAwakeMs);
        options.send(value.control);
        lastId = id;
      }
      const temporary = join(options.directory, `.pibot-routine-result-${randomUUID()}.tmp`);
      try {
        const result = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        try {
          await result.writeFile(JSON.stringify({ id, status: "forwarded" }));
        } finally {
          await result.close();
        }
        await rename(temporary, output);
        acknowledgedId = id;
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") failed();
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed();
      // No acknowledgement means no success. A partial writer can retry its ID on the next tick.
    } finally {
      if (!closed)
        timer = setTimeout(() => {
          pending = check();
        }, 250);
    }
  }
  pending = check();
  return {
    async stop() {
      closed = true;
      clearTimeout(timer);
      await pending;
    },
  };
}
