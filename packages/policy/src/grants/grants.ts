import { isIP } from "node:net";
import { type Grant, type GrantScope, GrantScopeSchema } from "@pibot/protocol-base";
import type { GrantCandidate, Platform, PolicyResult } from "../core/types.ts";
import { containsPath } from "../paths/paths.ts";

/**
 * Site rule: a remembered site also covers its subdomains at a dot boundary
 * (`example.com` covers `www.example.com`, not `evil-example.com`); IP addresses match exactly.
 */
export function siteCovers(held: string, wanted: string) {
  return held === wanted || (isIP(held) === 0 && wanted.endsWith(`.${held}`));
}

export function matchesGrant(grant: Grant, candidate: GrantCandidate, platform: Platform): boolean {
  if (
    grant.revokedAt !== null ||
    grant.botId !== candidate.botId ||
    grant.category !== candidate.category
  )
    return false;
  const held = grant.scope;
  const wanted = candidate.scope;
  if (held.kind !== wanted.kind) return false;
  if (held.kind === "send_target" && wanted.kind === "send_target")
    return (
      held.connectorId === wanted.connectorId &&
      held.tool === wanted.tool &&
      held.definitionDigest === wanted.definitionDigest &&
      held.targetDigest === wanted.targetDigest
    );
  if (held.kind === "connector_tool" && wanted.kind === "connector_tool")
    return (
      held.connectorId === wanted.connectorId &&
      held.tool === wanted.tool &&
      held.definitionDigest === wanted.definitionDigest
    );
  if (held.kind === "secret" && wanted.kind === "secret") return held.name === wanted.name;
  if (held.kind === "connector" && wanted.kind === "connector")
    return held.connectorId === wanted.connectorId;
  if (held.kind === "domain" && wanted.kind === "domain") return held.domain === wanted.domain;
  if (held.kind === "login" && wanted.kind === "login") return held.site === wanted.site;
  if (held.kind === "submit" && wanted.kind === "submit")
    return siteCovers(held.domain, wanted.domain);
  if (held.kind === "web_read" && wanted.kind === "web_read") return true;
  if (held.kind === "paid_image" && wanted.kind === "paid_image")
    return held.provider === wanted.provider && held.model === wanted.model;
  if (held.kind === "folder" && wanted.kind === "folder")
    return (
      sameExecutionTarget(held.target, wanted.target) &&
      containsPath(held.path, wanted.path, platform)
    );
  if (held.kind === "workplace" && wanted.kind === "workplace")
    return (
      sameExecutionTarget(held.target, wanted.target) &&
      workplaceCovers(held, wanted, candidate.writableRoots, platform)
    );
  if (held.kind === "programs" && wanted.kind === "programs") {
    const set = new Set(held.programs);
    return (
      sameExecutionTarget(held.target, wanted.target) &&
      workplaceCovers(held, wanted, candidate.writableRoots, platform) &&
      // The cwd-derived scope alone cannot prove a legacy grant covers redirected paths.
      (!!held.topicId ||
        ((!wanted.topicId || candidate.commandPaths !== undefined) &&
          (candidate.commandPaths ?? []).every((path) =>
            containsPath(held.root, path, platform),
          ))) &&
      set.size === new Set(wanted.programs).size &&
      wanted.programs.every((program) => set.has(program))
    );
  }
  return false;
}
function workplaceCovers(
  held: { root: string; topicId?: string },
  wanted: { root: string; topicId?: string },
  roots: readonly string[] | undefined,
  platform: Platform,
) {
  const sameRoot =
    containsPath(held.root, wanted.root, platform) &&
    containsPath(wanted.root, held.root, platform);
  // Historical grants keep their exact-root meaning. Only new topic-bound grants expand.
  if (!held.topicId) return sameRoot;
  return (
    held.topicId === wanted.topicId &&
    !!roots &&
    roots.some(
      (root) =>
        containsPath(root, wanted.root, platform) && containsPath(wanted.root, root, platform),
    )
  );
}
function sameExecutionTarget(held: string | undefined, wanted: string | undefined) {
  return (held ?? "local") === (wanted ?? "local");
}
export function createGrantScope(result: PolicyResult): GrantScope | undefined {
  return result.canRemember && result.grantScope
    ? GrantScopeSchema.parse(result.grantScope)
    : undefined;
}
