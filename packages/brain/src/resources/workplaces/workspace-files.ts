import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExecutionTarget, WorkspacePage, WorkspaceStat } from "@pibot/execution";
import { fileIdentity } from "@pibot/execution";
import { RpcError, type WorkspaceSnapshot } from "@pibot/protocol-base";
import { abortable } from "../../core/abort.ts";
import type { LocalService } from "../../local-service.ts";
import { deliveryFile } from "../../runtime/workflows/delivery-path.ts";

export interface WorkspaceFileAccess {
  readonly remote: boolean;
  readonly location?: WorkspaceSnapshot["location"];
  readonly root?: string;
  readonly revision?: number;
  readonly paths: typeof path.posix;
  canonical(path: string, signal: AbortSignal): Promise<string>;
  resolveInput(path: string): string | undefined;
  probe(
    path: string,
    signal: AbortSignal,
  ): Promise<{ kind: "file" | "directory" | "blocked" } | null>;
  inspect(path: string, signal: AbortSignal): Promise<WorkspaceStat | null>;
  page(
    path: string,
    signal: AbortSignal,
    offset?: number,
    version?: string,
    limit?: number,
  ): Promise<WorkspacePage>;
  entries(path: string, signal: AbortSignal): Promise<WorkspacePage["entries"]>;
  read(
    root: string,
    path: string,
    signal: AbortSignal,
    maxBytes?: number,
  ): Promise<{ size: number; data?: Buffer } | undefined>;
  create(path: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
}
function entries(access: Pick<WorkspaceFileAccess, "page">, path: string, signal: AbortSignal) {
  return (async () => {
    const result: WorkspacePage["entries"] = [];
    let offset = 0,
      version: string | undefined;
    for (;;) {
      const page = await access.page(path, signal, offset, version);
      result.push(...page.entries);
      if (!page.more) return result;
      if (page.offset <= offset || page.offset >= 10000)
        throw new RpcError(-32602, "workspace_directory_limit");
      offset = page.offset;
      version = page.version;
    }
  })();
}
/** The local adapter preserves the existing filesystem behavior; runner IO never uses host paths. */
export const localWorkspaceFiles: WorkspaceFileAccess = {
  remote: false,
  paths: path,
  async canonical(path, signal) {
    const value = await realpath(path);
    signal.throwIfAborted();
    return value;
  },
  resolveInput(value) {
    const resolved = value.startsWith("~") ? path.join(homedir(), value.slice(1)) : value;
    return path.isAbsolute(resolved) ? resolved : undefined;
  },
  async probe(path, signal) {
    try {
      const info = await abortable(stat(path), signal);
      signal.throwIfAborted();
      return { kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "blocked" };
    } catch {
      // Best-effort input inference skips unavailable paths; its caller rechecks owner cancellation.
      return null;
    }
  },
  async inspect(path, signal) {
    signal.throwIfAborted();
    const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return undefined;
      throw error;
    });
    signal.throwIfAborted();
    if (!info) return null;
    return {
      kind: info.isSymbolicLink()
        ? "blocked"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "blocked",
      size: Number(info.size),
      ...fileIdentity(info),
      links: String(info.nlink),
      version: createHash("sha256")
        .update([path, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"))
        .digest("hex"),
    };
  },
  async page(path, signal, offset = 0, version, limit = 200) {
    const before = await localWorkspaceFiles.inspect(path, signal);
    if (before?.kind !== "directory" || (version && before.version !== version))
      throw new RpcError(-32602, "workspace_directory_changed");
    const dir = await opendir(path);
    let scanned = 0;
    const items: WorkspacePage["entries"] = [];
    let more = false;
    try {
      while (scanned < offset + limit) {
        signal.throwIfAborted();
        const entry = await dir.read();
        if (!entry) break;
        scanned++;
        if (scanned > offset)
          items.push({
            name: entry.name,
            kind: entry.isSymbolicLink()
              ? "blocked"
              : entry.isDirectory()
                ? "directory"
                : entry.isFile()
                  ? "file"
                  : "blocked",
          });
      }
      more = !!(await dir.read());
    } finally {
      await dir.close();
    }
    if ((await localWorkspaceFiles.inspect(path, signal))?.version !== before.version)
      throw new RpcError(-32602, "workspace_directory_changed");
    return { entries: items, offset: scanned, version: before.version, more };
  },
  entries(path, signal) {
    return entries(localWorkspaceFiles, path, signal);
  },
  read: deliveryFile,
  async create(path, data, signal) {
    await mkdir(localWorkspaceFiles.paths.dirname(path), { recursive: true });
    const parent = await lstat(localWorkspaceFiles.paths.dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory())
      throw new RpcError(-32602, "workflow_folder_unavailable");
    await writeFile(path, data, { flag: "wx", signal });
  },
};
export function workspaceFiles(
  local: LocalService,
  boundary: WorkspaceSnapshot,
  assertCurrent: () => void = () => {},
): WorkspaceFileAccess {
  const location = boundary.location;
  if (!location || location.target === "local") return localWorkspaceFiles;
  const target: ExecutionTarget = local.targetFor(location);
  const paths = location.platform === "win32" ? path.win32 : path.posix;
  const current = () => {
    local.shutdown.signal.throwIfAborted();
    assertCurrent();
    if (local.targetFor(location) !== target)
      throw new RpcError(-32602, "execution_target_changed");
  };
  const context = (path: string, signal: AbortSignal) => {
    current();
    signal.throwIfAborted();
    return {
      path,
      cwd: boundary.primaryPath,
      signal,
      writeRoots: [...boundary.writeRoots],
      denyWriteRoots: [...boundary.denyWriteRoots],
      rootIdentities: boundary.roots.map((r) => ({
        canonicalPath: r.canonicalPath,
        device: r.device,
        inode: r.inode,
        role: r.role === "primary" ? ("primary" as const) : ("readonly" as const),
      })),
      expectedPath: paths.resolve(boundary.primaryPath, path),
      assertCurrent: current,
    };
  };
  const roots = [boundary.primaryPath, ...boundary.roots.map((root) => root.canonicalPath)];
  const inside = (path: string) => {
    const target = paths.resolve(boundary.primaryPath, path);
    return roots.some((root) => {
      const rel = paths.relative(root, target);
      return !rel || (!paths.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${paths.sep}`));
    });
  };
  const access: WorkspaceFileAccess = {
    remote: true,
    location,
    root: boundary.primaryPath,
    revision: boundary.revision,
    paths,
    async canonical(path, signal) {
      const info = await access.inspect(path, signal);
      if (!info) throw new RpcError(-32602, "workspace_path_missing");
      return paths.resolve(boundary.primaryPath, path);
    },
    resolveInput(path) {
      return paths.isAbsolute(path) ? path : undefined;
    },
    async probe(path, signal) {
      try {
        return await access.inspect(path, signal);
      } catch (error) {
        if (signal.aborted) return null;
        throw error;
      }
    },
    async inspect(path, signal) {
      if (!target.inspectPath) throw new RpcError(-32601, "workspace_files_unsupported");
      // Like the local read: a path outside the workplace is simply not there. Asking the runner
      // would fail the whole delivery check on one stray reference (`D:\other.md`) instead.
      if (!inside(path)) return null;
      const result = await target.inspectPath(context(path, signal));
      current();
      return result;
    },
    async page(path, signal, offset = 0, version, limit = 200) {
      if (!target.listEntries) throw new RpcError(-32601, "workspace_files_unsupported");
      const result = await target.listEntries({ ...context(path, signal), offset, version, limit });
      current();
      return result;
    },
    entries(path, signal) {
      return entries(access, path, signal);
    },
    async read(root, path, signal, maxBytes) {
      const targetPath = paths.resolve(root, path),
        rel = paths.relative(root, targetPath);
      if (!rel || paths.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${paths.sep}`))
        return undefined;
      const info = await access.inspect(targetPath, signal);
      if (info?.kind !== "file" || info.links !== "1") return undefined;
      if (maxBytes === undefined || info.size > maxBytes) return { size: info.size };
      const file = await target.readBinary({ ...context(targetPath, signal), maxBytes });
      const after = await access.inspect(targetPath, signal);
      if (after?.version !== info.version || file.bytes.length !== info.size)
        throw new RpcError(-32602, "workspace_file_changed");
      return { size: info.size, data: file.bytes };
    },
    async create(path, data, signal) {
      if (!data.length) {
        await target.writeFile({ ...context(path, signal), content: "", expectedHash: null });
        current();
        return;
      }
      await target.writeBinary({
        ...context(path, signal),
        bytes: data,
        revalidate: async () => {
          current();
          signal.throwIfAborted();
        },
      });
      current();
    },
  };
  return access;
}
