import type {
  PermissionsSettings,
  PolicyStep,
  RoutinePreauth,
  RoutinePreauthInput,
  WorkspaceSnapshot,
} from "@pibot/protocol-base";
import { RoutinePreauthInputSchema } from "@pibot/protocol-base";
import type { PolicyTrace } from "../core/explain.ts";
import { scriptPinnedScope } from "../core/script-consent.ts";
import type { Platform, PolicyResult } from "../core/types.ts";
import { containsPath } from "../paths/paths.ts";
import { siteCovers } from "./grants.ts";

/**
 * Whether consent given under `saved` still describes `current`: the same roots (path, inode,
 * role), the same primary, the same read / write / deny sets. Order and `revision` are bookkeeping
 * of who owned the folder list and are not compared;
 * any added, removed or swapped root still voids the consent.
 */
export function sameWorkspace(
  saved: WorkspaceSnapshot,
  current: WorkspaceSnapshot,
  platform: Platform,
) {
  const normal = (value: WorkspaceSnapshot) =>
    JSON.stringify({
      boundaryVersion: value.boundaryVersion,
      location: {
        target: value.location?.target ?? "local",
        platform: value.location?.platform ?? platform,
      },
      conflict: value.conflict,
      roots: [...value.roots]
        .sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath))
        .map((root) => ({
          id: root.id,
          role: root.role,
          path: root.path,
          canonicalPath: root.canonicalPath,
          device: root.device,
          inode: root.inode,
        })),
      primaryId: value.primaryId,
      primaryPath: value.primaryPath,
      readonlySource: value.readonlySource ?? null,
      readRoots: [...value.readRoots].sort(),
      writeRoots: [...value.writeRoots].sort(),
      denyWriteRoots: [...value.denyWriteRoots].sort(),
    });
  return normal(saved) === normal(current);
}

// Consent can narrow the current ceiling, never replace policy's deny/danger/disclosure result.
export function preauthorizableOperation(
  category: string,
  result: PolicyResult,
  boundary: WorkspaceSnapshot | undefined,
  platform: Platform,
  isolated: boolean,
  trace?: PolicyTrace,
): RoutinePreauthInput | undefined {
  if (result.decision === "deny") return preauthUnavailable(trace, "routine_policy_denied");
  if (result.risk === "danger")
    return preauthUnavailable(trace, "routine_preauth_danger", "danger");
  // A read script that could not be proven offers consent pinned to that script, only
  // on the ordinary "cannot fully analyse" ask (any stronger card has removed the scope).
  const pinned =
    category === "run_command" &&
    result.decision === "ask" &&
    result.reason === "incomplete_analysis" &&
    result.scriptScope?.kind === "programs" &&
    scriptPinnedScope(result.scriptScope.programs)
      ? result.scriptScope
      : undefined;
  const scope = result.canRemember && result.grantScope ? result.grantScope : pinned;
  if (!scope) return preauthUnavailable(trace);
  if (boundary?.conflict !== "none")
    return preauthUnavailable(trace, "routine_workspace_unavailable", "boundary");
  if (
    category === "run_command" &&
    (!isolated || (boundary.denyWriteRoots.length && platform !== "darwin"))
  )
    return preauthUnavailable(trace, "routine_isolation_unavailable", "boundary");
  const parsed = RoutinePreauthInputSchema.safeParse({ category, scope });
  if (!parsed.success) return preauthUnavailable(trace);
  const op = parsed.data;
  if (op.scope.kind === "workplace" || op.scope.kind === "programs") {
    const root = op.scope.root;
    if (
      !boundary.writeRoots.some((r) => containsPath(r, root, platform)) ||
      boundary.denyWriteRoots.some((r) => containsPath(r, root, platform))
    )
      return preauthUnavailable(trace, "routine_readonly_workplace", "boundary");
  }
  trace?.step("grant", "routine_preauth_eligible", "info");
  return op;
}

export function preauthInvalidReason(
  record: RoutinePreauth,
  settings: PermissionsSettings,
  boundary: WorkspaceSnapshot,
  platform: Platform,
  isolated: boolean,
  trace?: PolicyTrace,
  source: PolicyStep["source"] = "default",
): "permission" | "workspace" | "isolation" | undefined {
  const op = record.operation;
  if (record.revokedAt) return invalidPreauth("permission", trace);
  trace?.step("level", "permission_level", "info", {
    level: settings.levels[op.category],
    source,
  });
  if (settings.levels[op.category] === "never") return invalidPreauth("permission", trace);
  // Operating the computer is bounded by its app list, not by folders; an automatic
  // login by its saved site, which the web gate re-checks on every call.
  if (op.scope.kind === "send_target")
    return settings.levels.connector === "never"
      ? invalidPreauth("permission", trace)
      : validPreauth(trace);
  // A paid image pre-approval is bounded by the Bot's exact model; the image gate re-checks the
  // network allowlist and the web level on every generation.
  if (
    op.scope.kind === "apps" ||
    op.scope.kind === "login" ||
    op.scope.kind === "connector" ||
    op.scope.kind === "paid_image"
  )
    return validPreauth(trace);
  // A form submission is bounded by its site, like a login; the network list still
  // applies (subdomains included).
  if (op.scope.kind === "submit") {
    const domain = op.scope.domain;
    return settings.network.allowAll ||
      settings.network.domains.some((entry) => siteCovers(entry, domain))
      ? validPreauth(trace)
      : invalidPreauth("permission", trace);
  }
  if (
    op.scope.kind === "programs" &&
    op.scope.programs.some((p) => /^(sudo|su|doas|shutdown|reboot|halt|poweroff)$/i.test(p))
  )
    return invalidPreauth("permission", trace);
  if (
    op.scope.kind === "domain" &&
    !settings.network.allowAll &&
    !settings.network.domains.includes(op.scope.domain)
  )
    return invalidPreauth("permission", trace);
  if (
    !record.workspaceSnapshot ||
    !sameWorkspace(record.workspaceSnapshot, boundary, platform) ||
    boundary.conflict !== "none"
  )
    return invalidPreauth("workspace", trace);
  if (
    op.scope.kind === "programs" &&
    (!isolated || (boundary.denyWriteRoots.length && platform !== "darwin"))
  )
    return invalidPreauth("isolation", trace);
  if (op.scope.kind === "programs" || op.scope.kind === "workplace") {
    const root = op.scope.root;
    if (
      !boundary.writeRoots.some((r) => containsPath(r, root, platform)) ||
      boundary.denyWriteRoots.some((r) => containsPath(r, root, platform))
    )
      return invalidPreauth("workspace", trace);
  }
  return validPreauth(trace);
}

export function matchesRoutinePreauth(
  held: RoutinePreauthInput,
  wanted: RoutinePreauthInput,
  platform: Platform,
  trace?: PolicyTrace,
) {
  const match = (value: boolean) => {
    trace?.step(
      "grant",
      value ? "routine_preauth_matched" : "routine_preauth_not_matched",
      value ? "info" : "narrow",
    );
    return value;
  };
  if (held.category !== wanted.category || held.scope.kind !== wanted.scope.kind)
    return match(false);
  const a = held.scope,
    b = wanted.scope;
  if (a.kind === "connector" && b.kind === "connector")
    return match(a.connectorId === b.connectorId);
  if (a.kind === "send_target" && b.kind === "send_target")
    return match(
      a.connectorId === b.connectorId &&
        a.tool === b.tool &&
        a.target === b.target &&
        a.definitionDigest === b.definitionDigest &&
        a.targetDigest === b.targetDigest,
    );
  if (a.kind === "domain" && b.kind === "domain") return match(a.domain === b.domain);
  if (a.kind === "login" && b.kind === "login") return match(a.site === b.site);
  if (a.kind === "paid_image" && b.kind === "paid_image")
    return match(a.provider === b.provider && a.model === b.model);
  if (a.kind === "submit" && b.kind === "submit") return match(siteCovers(a.domain, b.domain));
  if (a.kind === "apps" && b.kind === "apps") {
    const apps = new Set(a.apps.map((app) => app.toLowerCase()));
    return match(b.apps.every((app) => apps.has(app.toLowerCase())));
  }
  if (a.kind === "folder" && b.kind === "folder")
    return match(
      (a.target ?? "local") === (b.target ?? "local") && containsPath(a.path, b.path, platform),
    );
  if (a.kind === "workplace" && b.kind === "workplace")
    return match(
      (a.target ?? "local") === (b.target ?? "local") && containsPath(a.root, b.root, platform),
    );
  if (a.kind === "programs" && b.kind === "programs") {
    const programs = new Set(a.programs);
    // Consent pinned to one script covers exactly that script (same digest, file and
    // directory) and is never covered by, nor covers, a consent for named programs.
    const pinned = scriptPinnedScope(a.programs);
    if (pinned || scriptPinnedScope(b.programs))
      return match(
        pinned &&
          scriptPinnedScope(b.programs) &&
          (a.target ?? "local") === (b.target ?? "local") &&
          containsPath(a.root, b.root, platform) &&
          containsPath(b.root, a.root, platform) &&
          programs.size === new Set(b.programs).size &&
          b.programs.every((p) => programs.has(p)),
      );
    return match(
      (a.target ?? "local") === (b.target ?? "local") &&
        containsPath(a.root, b.root, platform) &&
        b.programs.every((p) => programs.has(p)),
    );
  }
  return match(false);
}

function preauthUnavailable(
  trace: PolicyTrace | undefined,
  code = "routine_preauth_unavailable",
  axis: "grant" | "danger" | "boundary" = "grant",
): undefined {
  trace?.step(axis, code, "narrow");
  return undefined;
}
function validPreauth(trace: PolicyTrace | undefined): undefined {
  trace?.step("grant", "routine_preauth_valid", "info");
  return undefined;
}
function invalidPreauth(
  reason: "permission" | "workspace" | "isolation",
  trace: PolicyTrace | undefined,
) {
  trace?.step("boundary", reason, "narrow");
  return reason;
}
