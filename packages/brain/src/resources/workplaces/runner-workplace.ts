import { posix, win32 } from "node:path";
import { containsPath } from "@pibot/policy";
import { RpcError, type Workplaces, WorkspaceSnapshotSchema } from "@pibot/protocol-base";
import type { ExecutionTargets } from "./execution-targets.ts";

export async function runnerWorkplace(
  value: Workplaces,
  targets: ExecutionTargets,
  signal: AbortSignal,
) {
  if (
    value.folders.some(
      (f) =>
        f.role === "writable" && value.folders.some((r) => r.location && r.location !== "local"),
    )
  )
    throw new RpcError(-32601, "runner_writable_unsupported");
  const primary = value.folders.find((f) => f.id === value.currentId);
  const location = primary?.location;
  if (!location || location === "local") {
    if (value.folders.some((f) => f.location && f.location !== "local"))
      throw new RpcError(-32602, "workspace_targets_mixed");
    return;
  }
  if (value.folders.some((f) => f.location !== location))
    throw new RpcError(-32602, "workspace_targets_mixed");
  const { target, platform } = targets.require(location);
  const path = platform === "win32" ? win32 : posix;
  const roots = await Promise.all(
    value.folders.map(async (folder) => {
      const result = await target.canonicalizePath(folder.path, folder.path, signal);
      if (!result.device || !result.inode || result.path !== path.resolve(folder.path))
        throw new RpcError(-32602, "workspace_boundary_changed");
      return {
        id: folder.id,
        path: folder.path,
        canonicalPath: result.path,
        device: result.device,
        inode: result.inode,
        role: folder.id === value.currentId ? ("primary" as const) : ("readonly" as const),
      };
    }),
  );
  const denyWriteRoots = roots.filter((r) => r.role === "readonly").map((r) => r.canonicalPath);
  const conflict = denyWriteRoots.some((root) => containsPath(root, primary.path, platform))
    ? "readonly_overlaps_primary"
    : "none";
  const boundary = WorkspaceSnapshotSchema.parse({
    boundaryVersion: 1,
    location: { target: location, platform },
    conflict,
    roots,
    revision: value.revision ?? 0,
    primaryId: primary.id,
    primaryPath: primary.path,
    readRoots: roots.map((r) => r.canonicalPath),
    writeRoots: conflict === "none" ? [primary.path] : [],
    denyWriteRoots,
  });
  // A remote workspace never implicitly imports the desktop Bot home into its read roots.
  return {
    value: { ...value, home: primary.path },
    cwd: primary.path,
    home: primary.path,
    roots: boundary.readRoots,
    boundary,
  };
}
