import { basename } from "node:path";
import type { ChangesRoot, ChangesScope, WorkspaceLocal as LocalService } from "@pibot/brain/kit";
import { containsPath } from "@pibot/policy";
import { BotsRepo, ConversationsRepo, GroupsRepo } from "@pibot/storage";
import {
  type ChangesErrorCode,
  type ChangesTarget,
  RpcError,
  RpcErrorCodes,
  type WorkspaceSnapshot,
} from "@pibot/workspaces-contract/full";
import { groupWorkplace } from "../runtime.ts";
import { worktreeViews } from "./review/changes-worktree-views.ts";

export type { ChangesRoot, ChangesScope } from "@pibot/brain/kit";

export function changesError(code: ChangesErrorCode): RpcError {
  const rpc =
    code === "changes_busy"
      ? RpcErrorCodes.busy
      : code === "changes_isolation_unavailable" ||
          code === "changes_git_unavailable" ||
          code === "changes_draft_unavailable"
        ? RpcErrorCodes.unsupported
        : RpcErrorCodes.invalidParams;
  return new RpcError(rpc, code);
}

/**
 * How the user's discard / commit would run: in the command sandbox, or, as the
 * Windows exception, directly with the hardened runner; null when neither is allowed.
 */
export function writeMode(
  platform: NodeJS.Platform,
  isolation: { available: boolean; reason?: string },
): "sandbox" | "direct" | null {
  if (isolation.available) return "sandbox";
  return platform === "win32" && isolation.reason === "windows_unisolated" ? "direct" : null;
}

export async function resolveChangesScope(
  local: LocalService,
  target: ChangesTarget,
  signal: AbortSignal,
): Promise<ChangesScope> {
  const [kind, id] = target.conversationKey.split(":") as ["dm" | "group", string];
  const bots = new BotsRepo(local.deps.db);
  let place: {
    value: { folders: { id: string; name: string }[] };
    home: string;
    boundary: WorkspaceSnapshot;
  };
  let botId: string;
  let groupId: string | undefined;
  let conversationId: string | undefined;
  if (kind === "group") {
    const group = new GroupsRepo(local.deps.db).get(id);
    if (!group) throw new RpcError(RpcErrorCodes.invalidParams, "Unknown group");
    botId = group.coordinatorBotId;
    groupId = group.id;
    conversationId = group.conversationId;
    place = await groupWorkplace(local, botId, group, signal);
  } else {
    botId = id;
    // The topic's own folders; without a topic, what a new topic would start with.
    let selection: ReturnType<LocalService["workplaces"]["topic"]> | undefined;
    if (target.topicId) {
      const topic = new ConversationsRepo(local.deps.db).get(target.topicId);
      if (topic?.kind !== "dm" || topic.botId !== botId || topic.archivedAt)
        throw new RpcError(RpcErrorCodes.invalidParams, "Unknown topic");
      selection = local.workplaces.topic(topic.id);
      conversationId = topic.id;
    }
    place = await local.workplaces.context(botId, signal, selection);
  }
  if (place.boundary.location?.target.startsWith("runner:"))
    throw new RpcError(RpcErrorCodes.unsupported, "runner_changes_unsupported");
  const bot = bots.get(botId);
  if (!bot || bot.archivedAt) throw new RpcError(RpcErrorCodes.invalidParams, "Unknown active Bot");
  const names = new Map(place.value.folders.map((folder) => [folder.id, folder.name]));
  const roots: ChangesRoot[] = place.boundary.roots.map((root) => ({
    id: root.id,
    name: names.get(root.id) ?? basename(root.canonicalPath),
    path: root.canonicalPath,
    role: root.role,
    device: root.device,
    inode: root.inode,
  }));
  const primary = roots.find((root) => root.id === place.boundary.primaryId);
  if (!primary) throw new RpcError(RpcErrorCodes.invalidParams, "Unknown working folder");
  const views = await worktreeViews(
    local,
    primary,
    botId,
    groupId,
    conversationId,
    target.rootId,
    signal,
  );
  const rootIds = new Set(roots.map((value) => value.id));
  const choices = views
    .filter((value) => !rootIds.has(value.id))
    .sort((a, b) => Number(b.id === target.rootId) - Number(a.id === target.rootId))
    .slice(0, Math.max(0, 251 - roots.length));
  const root = [...roots, ...choices].find(
    (r) => r.id === (target.rootId ?? place.boundary.primaryId),
  );
  if (!primary || !root) throw new RpcError(RpcErrorCodes.invalidParams, "Unknown working folder");
  return {
    conversationKey: target.conversationKey,
    ...(target.topicId ? { topicId: target.topicId } : {}),
    botId,
    botName: bot.name,
    home: place.home,
    ...(groupId ? { groupId } : {}),
    ...(conversationId ? { conversationId } : {}),
    roots,
    views: choices,
    root,
    primary,
    ...(place.boundary.readonlySource ? { readonlySource: place.boundary.readonlySource } : {}),
    boundaryConflict: place.boundary.conflict !== "none",
    nestedReadonly:
      place.boundary.conflict !== "none" ||
      place.boundary.denyWriteRoots.some((path) =>
        containsPath(root.path, path, local.deps.platform),
      ),
  };
}
