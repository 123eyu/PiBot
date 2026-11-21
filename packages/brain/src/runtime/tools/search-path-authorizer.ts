import { resolve } from "node:path";
import { ExecError } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import type { PreparedTool } from "../../core/local-types.ts";
import { runPermissionSources, runPermissions } from "../../core/run-permissions.ts";
import { createReadPathBoundary } from "./local-read-boundary.ts";
import type { LocalRun } from "./local-run.ts";
import { pathRegion } from "./path-prefix-matcher.ts";
import { searchAuthorization } from "./search-authorization.ts";

/** Reuse only this search's consumed root consent; never issue a prompt for each descendant. */
export async function searchPathAuthorizer(
  run: LocalRun,
  prepared: PreparedTool,
  signal: AbortSignal,
) {
  const { local, context } = run;
  const boundary = await createReadPathBoundary(
    local,
    context,
    signal,
    undefined,
    searchAuthorization(local, context),
  );
  // The root is the approval subject: a folder, or the single file search_text was given.
  // containsPath then narrows a file root to that file, so no sibling path can be authorized.
  const root = prepared.result.path?.path;
  if (!root || prepared.authorization !== boundary.authorization)
    throw new ExecError("outside_workplace");
  const policy = await local.getPolicy(signal);
  const settings = local.tasks.settings(context, runPermissions(local, context));
  const permissionSources = runPermissionSources(local, context);
  const grants = local.grants(context.botId, context);
  const platform = boundary.workplace.boundary.location?.platform ?? local.deps.platform;
  const remote = boundary.workplace.boundary.location?.target.startsWith("runner:");
  const regions = [
    ...new Set([
      root,
      ...boundary.workplace.boundary.readRoots,
      ...boundary.workplace.boundary.writeRoots,
      ...boundary.workplace.boundary.denyWriteRoots,
      ...(prepared.sensitiveReadRoots ?? []),
    ]),
  ];
  const region = pathRegion(regions, platform);
  const regionKey = (category: string, path: string) => `${category}:${region(path)}`;
  const cache = new Map<string, boolean>();
  const evaluate = async (
    path: string,
    category: "read_file" | "list_dir",
    current: AbortSignal,
  ) => {
    const result = await policy.evaluate({
      botId: context.botId,
      request: { category, path },
      settings,
      permissionSources,
      sensitiveReadRoots: prepared.sensitiveReadRoots,
      grants,
      workplace: boundary.workplace.value,
      boundary: boundary.workplace.boundary,
      cwd: prepared.cwd,
      signal: current,
      // execution verifies the actual ancestors and file identities before exposing bytes.
      realpath: async (value, check) => {
        check.throwIfAborted();
        return remote ? run.target.realpath(value, check) : resolve(value);
      },
    });
    boundary.assertCurrent(current);
    return result.decision !== "deny" && result.path?.path === path;
  };
  // Seed both categories: allowing a directory listing never implies allowing file contents.
  for (const category of prepared.call.tool === "search_text"
    ? (["list_dir", "read_file"] as const)
    : (["list_dir"] as const)) {
    boundary.assertCurrent(signal);
    const key = regionKey(category, root);
    cache.set(key, await evaluate(root, category, signal));
  }
  return async (path: string, kind: "directory" | "file", current: AbortSignal) => {
    boundary.assertCurrent(current);
    if (
      !containsPath(
        root,
        path,
        boundary.workplace.boundary.location?.platform ?? local.deps.platform,
      ) ||
      !boundary.permits(path)
    )
      return false;
    const category =
      kind === "file" && prepared.call.tool === "search_text" ? "read_file" : "list_dir";
    // For these two categories, grants change ask/allow but not denial. Path-dependent denials
    // are uniform within a read-root/sensitive-root region; permits still filters each filename.
    // Remote canonicalization can resolve aliases, so only local walks can reuse a prefix.
    const key = regionKey(category, path);
    const cached = remote ? undefined : cache.get(key);
    // A cache hit contains no await: the entry check is still current when it returns.
    if (cached !== undefined) return cached;
    const allowed = await evaluate(path, category, current);
    if (!remote) cache.set(key, allowed);
    boundary.assertCurrent(current);
    return allowed;
  };
}
