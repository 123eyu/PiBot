import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { TurnFileSource } from "@pibot/brain/kit";
import { directoryIdentity } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { BotsRepo, FileCheckpointsRepo, type RunFileSummary, RunsRepo } from "@pibot/storage";
import { previewKind, RpcError, RpcErrorCodes } from "@pibot/workspaces-contract/full";
import type { ChangesService } from "../changes-service.ts";

/** What a turn still shows: its recorded files minus those restored from its checkpoint. */
export function visibleTurn(service: ChangesService, runId: string) {
  const checkpoints = new FileCheckpointsRepo(service.local.deps.db);
  const checkpoint = checkpoints.capture(runId);
  const restored = checkpoints.restoredRunPaths(runId);
  const recorded = service.turn.repo.summarize(runId);
  return { checkpoint, recorded, summary: recorded.filter((file) => !restored.has(file.path)) };
}

/** Static half of the preview rule; turnFile adds the live checks when the file is read. */
export function turnPreviewable(
  file: Pick<RunFileSummary, "kind" | "root" | "path">,
  platform: ChangesService["platform"],
) {
  return (
    file.kind !== "delete" &&
    file.path !== file.root &&
    containsPath(file.root, file.path, platform) &&
    !!previewKind(basename(file.path))
  );
}

function refuse(reason: "preview_unavailable" | "preview_changed" | "preview_missing"): never {
  throw new RpcError(RpcErrorCodes.invalidParams, reason);
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * GUI preview authority for a file a run changed. The renderer's path is only a lookup key into
 * that run's visible turn changes (what its reply card lists); everything served comes from the
 * run's own record: the recorded path, inside the recorded workspace root, whose identity must
 * still match the one the write was recorded against. Content is read later by the caller through
 * `target.readBinary`, which re-verifies the root identity and refuses symlinks and hard links.
 */
export async function turnFile(
  service: ChangesService,
  runId: string,
  path: string,
  signal: AbortSignal,
  preview = true,
): Promise<TurnFileSource> {
  signal.throwIfAborted();
  const db = service.local.deps.db;
  const botId = service.turn.repo.botOf(runId);
  if (!botId || !new RunsRepo(db).get(runId) || !new BotsRepo(db).get(botId))
    refuse("preview_unavailable");
  const file = visibleTurn(service, runId).summary.find((item) => item.path === path);
  if (
    !file ||
    file.kind === "delete" ||
    file.path === file.root ||
    !containsPath(file.root, file.path, service.platform) ||
    (preview && !turnPreviewable(file, service.platform))
  )
    refuse("preview_unavailable");
  let rootIdentity: Awaited<ReturnType<typeof directoryIdentity>>;
  try {
    rootIdentity = await directoryIdentity(file.root);
  } catch (error) {
    refuse(missing(error) ? "preview_missing" : "preview_changed");
  }
  // A folder moved away and another put in its place is not the folder this run wrote into.
  if (
    rootIdentity.canonicalPath !== file.root ||
    (file.rootDevice !== null &&
      file.rootInode !== null &&
      (rootIdentity.device !== file.rootDevice || rootIdentity.inode !== file.rootInode))
  )
    refuse("preview_changed");
  const info = await lstat(file.path).catch((error: unknown) =>
    refuse(missing(error) ? "preview_missing" : "preview_changed"),
  );
  if (!info.isFile()) refuse(info.isDirectory() ? "preview_missing" : "preview_changed");
  if (!preview && info.nlink !== 1) refuse("preview_changed");
  // A symlinked parent swapped in after the run would point the recorded name elsewhere.
  const real = await realpath(file.path).catch((error: unknown) =>
    refuse(missing(error) ? "preview_missing" : "preview_changed"),
  );
  if (real !== file.path || !containsPath(rootIdentity.canonicalPath, real, service.platform))
    refuse("preview_changed");
  signal.throwIfAborted();
  return { botId, root: file.root, path: file.path, rootIdentity };
}
