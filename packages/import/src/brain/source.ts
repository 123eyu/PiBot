// Only the file chosen by the desktop user becomes readable by an import adapter.

import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { CapabilityContext } from "@pibot/brain/kit";
import { sensitiveReadBoundary } from "@pibot/execution";
import { nodeFileSystem, protectedPaths } from "@pibot/policy";
import { ImportFailure, type ImportFile, type ImportInput } from "./adapter.ts";

type HostPaths = Pick<
  CapabilityContext["local"]["deps"],
  "dataDir" | "env" | "platform" | "userHome"
>;
const MAX_FILE_BYTES = 1024n * 1024n * 1024n;
const CHUNK_BYTES = 64 * 1024;

function sameFile(left: BigIntStats, right: BigIntStats) {
  return (
    right.isFile() &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

async function authorize(deps: HostPaths, path: string, resolved: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const { platform, userHome, env, dataDir } = deps;
  const sensitive = await sensitiveReadBoundary(platform, [userHome], env);
  const policy = await protectedPaths(
    {
      platform,
      home: userHome,
      cwd: userHome,
      roots: [path, resolved],
      fs: nodeFileSystem,
      signal,
    },
    [...sensitive.denyRead, dataDir],
  );
  signal.throwIfAborted();
  if (policy.covers(path) || policy.covers(resolved)) throw new ImportFailure("source_changed");
}

export async function selectedInput(
  deps: HostPaths,
  path: string,
  signal: AbortSignal,
): Promise<ImportInput> {
  const resolved = await realpath(path);
  await authorize(deps, path, resolved, signal);
  const selected = await lstat(path, { bigint: true });
  if (!selected.isFile() || selected.nlink !== 1n) throw new ImportFailure("source_changed");
  if (selected.size > MAX_FILE_BYTES) throw new ImportFailure("limit");
  const file = (readSignal: AbortSignal) =>
    openSelected(deps, path, resolved, selected, readSignal);
  return Object.assign(
    async function* (readSignal: AbortSignal) {
      for await (const selectedFile of file(readSignal)) {
        for (let offset = 0; offset < selectedFile.size; offset += CHUNK_BYTES) {
          yield await selectedFile.read(offset, Math.min(CHUNK_BYTES, selectedFile.size - offset));
        }
      }
    },
    { file },
  );
}

async function* openSelected(
  deps: HostPaths,
  path: string,
  resolved: string,
  selected: BigIntStats,
  signal: AbortSignal,
): AsyncGenerator<ImportFile> {
  const current = await realpath(path);
  await authorize(deps, path, current, signal);
  if (current !== resolved || !sameFile(selected, await lstat(path, { bigint: true })))
    throw new ImportFailure("source_changed");
  signal.throwIfAborted();
  const file = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!sameFile(selected, await file.stat({ bigint: true })))
      throw new ImportFailure("source_changed");
    const size = Number(selected.size);
    yield {
      size,
      async read(position, length) {
        if (position < 0 || length < 0 || position + length > size)
          throw new ImportFailure("format");
        const buffer = Buffer.allocUnsafe(length);
        for (let offset = 0; offset < length; ) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
          if (!bytesRead) throw new ImportFailure("source_changed");
          offset += bytesRead;
        }
        signal.throwIfAborted();
        return buffer;
      },
    };
    if (
      !sameFile(selected, await file.stat({ bigint: true })) ||
      current !== (await realpath(path)) ||
      !sameFile(selected, await lstat(path, { bigint: true }))
    )
      throw new ImportFailure("source_changed");
    signal.throwIfAborted();
  } finally {
    await file.close();
  }
}
