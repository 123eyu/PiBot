import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { directoryIdentity } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { type MethodParams, RpcError, RpcErrorCodes } from "@pibot/workspaces-contract/full";
import { changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { turnFile } from "./changes-file.ts";

/** Only a recorded run file or the currently resolved sidebar root may reach the host. */
export async function revealChangedFile(
  service: ChangesService,
  input: MethodParams["changes.reveal"],
  signal: AbortSignal,
) {
  try {
    return await reveal(service, input, signal);
  } catch (error) {
    if (signal.aborted || error instanceof RpcError) throw error;
    // Filesystem exceptions include local paths; only a stable error crosses RPC.
    throw changesError("changes_stale");
  }
}

async function reveal(
  service: ChangesService,
  input: MethodParams["changes.reveal"],
  signal: AbortSignal,
) {
  const host = service.local.deps.host.revealPath;
  if (!host) throw new RpcError(RpcErrorCodes.unsupported, "path_reveal_unsupported");
  if ("runId" in input) {
    const file = await turnFile(service, input.runId, input.path, signal, false);
    const fresh = await turnFile(service, input.runId, input.path, signal, false);
    if (
      fresh.rootIdentity.device !== file.rootIdentity.device ||
      fresh.rootIdentity.inode !== file.rootIdentity.inode
    )
      throw changesError("changes_stale");
    signal.throwIfAborted();
    await host({ path: file.path, allowedRoots: [file.root] }, signal);
  } else {
    const scope = await service.scope(input.target, signal);
    if (isAbsolute(input.path) || input.path.split(/[\\/]/).some((part) => part === ".."))
      throw changesError("changes_stale");
    const root = await directoryIdentity(scope.root.path);
    if (
      (scope.root.device !== null && scope.root.device !== root.device) ||
      (scope.root.inode !== null && scope.root.inode !== root.inode)
    )
      throw changesError("changes_stale");
    const path = resolve(root.canonicalPath, input.path);
    if (
      root.canonicalPath !== scope.root.path ||
      !containsPath(root.canonicalPath, path, service.platform)
    )
      throw changesError("changes_stale");
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (await realpath(path)) !== path
    )
      throw changesError("changes_stale");
    const fresh = await service.scope(input.target, signal);
    const identity = await directoryIdentity(fresh.root.path);
    if (
      identity.canonicalPath !== root.canonicalPath ||
      identity.device !== root.device ||
      identity.inode !== root.inode
    )
      throw changesError("changes_stale");
    signal.throwIfAborted();
    await host({ path, allowedRoots: [root.canonicalPath] }, signal);
  }
  return { ok: true as const };
}
