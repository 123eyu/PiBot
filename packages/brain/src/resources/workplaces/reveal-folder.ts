import { lstat, realpath } from "node:fs/promises";
import { sameFile } from "@pibot/execution";
import { type KernelMethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { BotsRepo } from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";

/** Resolve only a currently visible record; a remembered path is never authority to open it. */
export async function revealWorkingFolder(
  local: LocalService,
  { botId, folderId }: KernelMethodParams["workplaces.reveal"],
  parent: AbortSignal,
) {
  const signal = AbortSignal.any([parent, local.shutdown.signal, AbortSignal.timeout(20_000)]);
  const unavailable = () => new RpcError(RpcErrorCodes.invalidParams, "working_folder_unavailable");
  const resolve = () => {
    if (!new BotsRepo(local.deps.db).get(botId)) throw unavailable();
    const places = local.workplaces.repo.list(botId);
    if (folderId === "home") return places.home;
    const folder = places.folders.find((item) => item.id === folderId);
    if (!folder) throw unavailable();
    if (folder.location && folder.location !== "local")
      throw new RpcError(RpcErrorCodes.unsupported, "path_reveal_unsupported");
    return folder.path;
  };
  const host = local.deps.host.revealPath;
  if (!host) throw new RpcError(RpcErrorCodes.unsupported, "path_reveal_unsupported");
  // App-owned homes retain their normal lazy creation; external records must already exist.
  if (folderId === "home") await local.workplaces.list(botId, signal);
  const path = resolve();
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || (await realpath(path)) !== path)
      throw unavailable();
    const after = await lstat(path, { bigint: true });
    signal.throwIfAborted();
    if (resolve() !== path || !sameFile(before, after)) throw unavailable();
    await host({ path, allowedRoots: [path] }, signal);
    local.approvals.audit.append({
      botId,
      kind: "file.revealed",
      summary: "Bot folder shown / 已定位 Bot 文件夹",
      detail: { actor: "user" },
    });
    return { ok: true as const };
  } catch (error) {
    if (error instanceof RpcError || signal.aborted) throw error;
    if (error instanceof Error && "code" in error) throw unavailable();
    throw error;
  }
}
