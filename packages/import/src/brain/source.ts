// Only the file chosen by the desktop user becomes readable by an import adapter.

import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { CapabilityContext } from "@pibot/brain/kit";
import { sensitiveReadBoundary } from "@pibot/execution";
import { nodeFileSystem, protectedPaths } from "@pibot/policy";
import { ImportFailure, type ImportInput } from "./adapter.ts";

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
  return (readSignal) => readSelected(deps, path, resolved, selected, readSignal);
}

async function* readSelected(
  deps: HostPaths,
  path: string,
  resolved: string,
  selected: BigIntStats,
  signal: AbortSignal,
) {
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
    let remaining = Number(selected.size);
    while (remaining > 0) {
      signal.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(remaining, CHUNK_BYTES));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) throw new ImportFailure("source_changed");
      remaining -= bytesRead;
      signal.throwIfAborted();
      yield chunk.subarray(0, bytesRead);
    }
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
