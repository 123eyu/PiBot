import { dirname, resolve } from "node:path";
import {
  type SemanticFileCache,
  type SemanticSnapshot,
  type SourceAccess,
  semanticHash,
  verifySnapshotRoot,
} from "@pibot/execution/semantic";
import { containsPath } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runPermissionSources, runPermissions } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { createReadPathBoundary } from "../tools/local-read-boundary.ts";

/** Automatic readers cannot consume the outer review tool's project-root consent. */
export async function reviewSourceAccess(
  local: LocalService,
  context: ToolRunContext,
  root: string,
  signal: AbortSignal,
  options: { directOnly?: boolean; cache?: SemanticFileCache } = {},
): Promise<SourceAccess> {
  const source = local.tasks.source(context);
  const selected = context.worktreeReview;
  if (selected) await local.changes.verifyReceipt(selected, signal, true);
  const boundary = await createReadPathBoundary(local, source, signal, selected?.root.path);
  if (selected) {
    if (root !== selected.root.path || boundary.workplace.cwd !== selected.source.path)
      throw new RpcError(-32602, "review_scope_invalid");
  }
  // This temporary read boundary belongs only to immutable snapshot capture/read. Ordinary tools
  // and the child task's execution workplace continue to use the original topic roots.
  const readBoundary = selected
    ? {
        ...boundary.workplace.boundary,
        roots: [
          {
            id: selected.rootId,
            path: root,
            canonicalPath: root,
            role: "readonly" as const,
            device: selected.root.device,
            inode: selected.root.inode,
          },
        ],
        readRoots: [root],
        writeRoots: [],
        denyWriteRoots: [root],
      }
    : boundary.workplace.boundary;
  const policy = await local.getPolicy(signal);
  const assertCurrent = (current: AbortSignal) => {
    local.tasks.guardSync(context);
    boundary.assertCurrent(current);
    if (selected) local.changes.assertReceipt(selected);
  };
  if (!readBoundary.roots.some((r) => containsPath(r.canonicalPath, root, local.deps.platform)))
    throw new RpcError(-32602, "project_unavailable");
  return {
    root,
    authorization: semanticHash(boundary.authorization),
    rootIdentities: readBoundary.roots,
    signal,
    ...(options.cache ? { cache: options.cache } : {}),
    assertCurrent,
    async authorize(path, kind, current) {
      assertCurrent(current);
      if (!containsPath(root, path, local.deps.platform) || !boundary.permits(path)) return false;
      const result = await policy.evaluate({
        botId: context.botId,
        request: { category: kind === "file" ? "read_file" : "list_dir", path },
        settings: local.tasks.settings(context, runPermissions(local, context)),
        permissionSources: runPermissionSources(local, context),
        grants: local.grants(context.botId, context),
        workplace: boundary.workplace.value,
        boundary: readBoundary,
        cwd: root,
        signal: current,
        realpath: async (value, check) => {
          check.throwIfAborted();
          return resolve(value);
        },
      });
      assertCurrent(current);
      return (
        (options.directOnly ? result.decision === "allow" : result.decision !== "deny") &&
        result.path?.path === path
      );
    },
  };
}
export async function assertFrozenAccess(snapshot: SemanticSnapshot, access: SourceAccess) {
  await verifySnapshotRoot(snapshot, access);
  const directories = new Set<string>([snapshot.root]);
  for (const file of snapshot.files) {
    let directory = dirname(resolve(snapshot.root, file.path));
    while (directory !== snapshot.root) {
      directories.add(directory);
      if (directories.size > 4096) throw new RpcError(-32602, "review_path_limit");
      const parent = dirname(directory);
      if (parent === directory) throw new RpcError(-32602, "review_scope_invalid");
      directory = parent;
    }
  }
  for (const path of directories)
    if (!(await access.authorize(path, "directory", access.signal)))
      throw new RpcError(-32602, "project_unavailable");
  for (const file of snapshot.files)
    if (!(await access.authorize(resolve(snapshot.root, file.path), "file", access.signal)))
      throw new RpcError(-32602, "project_unavailable");
  access.assertCurrent(access.signal);
}
