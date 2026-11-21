import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { LocalService } from "@pibot/brain/kit";
import { connectorPreauthIssue } from "@pibot/brain/kit";
import { containsPath, siteCovers } from "@pibot/policy";
import type { RoutineDraft, RoutinePreauthInput, WorkspaceSnapshot } from "@pibot/protocol";
import { AppBlocklistRepo } from "@pibot/storage";
import { prepareAssociations } from "../triggers/associations.ts";
import { appTriggerIssue } from "../validation/validation.ts";

export async function proposedBoundary(
  local: LocalService,
  draft: Partial<RoutineDraft> & { botId: string },
  signal: AbortSignal,
) {
  for (const trigger of draft.triggers ?? []) appTriggerIssue(local, draft.botId, trigger);
  // Capture the monitor additions without persisting them or promoting the primary root.
  return prepareAssociations(
    local,
    { ...draft, botId: draft.botId, triggers: draft.triggers ?? [], preauth: [] },
    signal,
  );
}

export async function proposalPreauthIssue(
  local: LocalService,
  botId: string,
  op: RoutinePreauthInput,
  boundary: WorkspaceSnapshot,
  signal: AbortSignal,
): Promise<"permission_ceiling" | "invalid_scope" | undefined> {
  signal.throwIfAborted();
  const settings = local.permissions.effective(botId);
  if (settings.levels[op.category] === "never") return "permission_ceiling";
  if (op.scope.kind === "domain") {
    const policy = await local.getPolicy(signal);
    const place = await local.workplaces.context(botId, signal);
    const result = await policy.evaluate({
      botId,
      settings,
      permissionSources: local.permissions.sources(botId),
      workplace: place.value,
      boundary,
      request: { category: "web", url: `https://${op.scope.domain}` },
      signal,
    });
    return result.decision === "deny" ? "permission_ceiling" : undefined;
  }
  // An app list is valid while none of its apps is blocklisted.
  if (op.scope.kind === "apps")
    return new AppBlocklistRepo(local.deps.db).blockedAmong(op.scope.apps).size
      ? "invalid_scope"
      : undefined;
  // An automatic login is valid while the Bot still has an account saved for the site.
  if (op.scope.kind === "login") {
    const site = op.scope.site;
    return local.credentials.hasSite(botId, site) ? undefined : "invalid_scope";
  }
  // A form submission preauthorization is valid while its site is still reachable
  // under the Bot's network settings (subdomains of the allowed list included).
  if (op.scope.kind === "submit") {
    const domain = op.scope.domain;
    const allowed =
      settings.network.allowAll ||
      settings.network.domains.some((entry) => siteCovers(entry, domain));
    return allowed ? undefined : "permission_ceiling";
  }
  if (op.scope.kind === "connector" || op.scope.kind === "send_target")
    return connectorPreauthIssue(local, botId, op);
  // "read public pages" is a chat-card grant; routine consent stays per site. A Bot never
  // proposes its own permission to spend money: paid image pre-approval is added by the user in
  // the routine editor (owner decision 2026-10-23).
  if (
    op.scope.kind === "connector_tool" ||
    op.scope.kind === "secret" ||
    op.scope.kind === "web_read" ||
    op.scope.kind === "paid_image"
  )
    return "invalid_scope";
  const root = op.scope.kind === "folder" ? op.scope.path : op.scope.root;
  try {
    const canonical = await realpath(root),
      info = await lstat(root);
    if (canonical !== resolve(root) || !info.isDirectory() || info.isSymbolicLink())
      return "invalid_scope";
    if (op.category === "write_file" || op.category === "run_command") {
      if (
        boundary.conflict !== "none" ||
        !boundary.writeRoots.some((path) => containsPath(path, canonical, local.deps.platform)) ||
        boundary.denyWriteRoots.some((path) => containsPath(path, canonical, local.deps.platform))
      )
        return "invalid_scope";
    } else if (!boundary.readRoots.some((r) => containsPath(r, canonical, local.deps.platform)))
      return "invalid_scope";
    if (op.scope.kind === "programs") {
      if (
        (boundary.denyWriteRoots.length && local.deps.platform !== "darwin") ||
        !(await local.target.isolationStatus(signal)).available
      )
        return "invalid_scope";
      if (
        op.scope.programs.some(
          (p) =>
            !/^[\w.+-]+$/.test(p) ||
            /^(sudo|su|doas|rm|rmdir|del|format|mkfs|dd|shutdown|reboot|poweroff)$/i.test(p),
        )
      )
        return "invalid_scope";
    }
    signal.throwIfAborted();
    return undefined;
  } catch {
    signal.throwIfAborted();
    return "invalid_scope";
  }
}
