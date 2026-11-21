import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileIdentityKey } from "@pibot/execution";
import {
  type Group,
  type KernelMethodParams,
  type KernelMethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { z } from "zod";
import { abortable } from "../../core/abort.ts";
import type { LocalService } from "../../local-service.ts";
import { type WorkspaceFileAccess, workspaceFiles } from "../workplaces/workspace-files.ts";
import { remoteGroupPage, remoteGroupPreview } from "./group-files-remote.ts";
import { groupWorkplace } from "./group-workplace.ts";

const cursorSchema = z.strictObject({
  root: z.string(),
  directory: z.string(),
  path: z.string(),
  offset: z.number().int().min(0).max(9999),
});
type Root = {
  group: Group;
  cwd: string;
  token: string;
  folderId?: string;
  access?: WorkspaceFileAccess;
};
const unavailable = () => new RpcError(-32602, "Group file location changed or unavailable");
// Exact (bigint) identity and nanosecond times: number stats alias nearby NTFS file IDs.
const directoryVersion = (path: string, info: BigIntStats) =>
  JSON.stringify([path, fileIdentityKey(info), String(info.mtimeNs), String(info.ctimeNs)]);

/** A UI read port, separate from agent tools and their executing-Bot authorization. */
export class GroupFilesService {
  private readonly key = randomBytes(32);
  private shutdown = new AbortController();
  private readonly requests = new Map<
    string,
    {
      groupId: string;
      abort: AbortController;
      operation: Promise<unknown>;
    }
  >();
  constructor(
    private readonly local: LocalService,
    private readonly group: (id: string) => Group,
  ) {}
  private sign(value: string) {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }
  private async root(id: string, signal: AbortSignal, folderId?: string): Promise<Root> {
    const group = this.group(id);
    const owner = group.coordinatorBotId;
    const own = folderId === "home";
    const folder = own
      ? undefined
      : group.folders?.find((f) => f.id === (folderId ?? group.primaryFolderId));
    if (folderId && !own && !folder) throw unavailable();
    const workplace = own ? undefined : await groupWorkplace(this.local, owner, group, signal);
    const cwd = own
      ? await this.local.workplaces.groupHome(id, signal)
      : (folder?.path ?? workplace?.cwd);
    if (!cwd) throw unavailable();
    if (folder?.location && workplace) {
      const access = workspaceFiles(this.local, workplace.boundary);
      const info = await access.inspect(cwd, signal);
      if (info?.kind !== "directory") throw unavailable();
      return {
        group,
        cwd,
        folderId: folder.id,
        access,
        token: this.sign(
          JSON.stringify([
            id,
            owner,
            group.conversationId,
            group.folders,
            group.primaryFolderId,
            group.workspaceRevision,
            cwd,
            info.device,
            info.inode,
          ]),
        ),
      };
    }
    const info = await lstat(cwd, { bigint: true });
    signal.throwIfAborted();
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    return {
      group,
      cwd,
      folderId: own ? "home" : folder?.id,
      token: this.sign(
        JSON.stringify([
          id,
          owner,
          group.workplace,
          group.folders,
          group.primaryFolderId,
          cwd,
          fileIdentityKey(info),
        ]),
      ),
    };
  }
  private async path(root: Root, relative: string, signal: AbortSignal) {
    if (root.access) {
      const target = root.access.paths.join(root.cwd, ...relative.split("/").filter(Boolean));
      await root.access.inspect(target, signal);
      return target;
    }
    let path = root.cwd;
    // Every component is checked, so even an in-root symlink is never a browse/open capability.
    for (const part of relative ? relative.split("/") : []) {
      signal.throwIfAborted();
      path = join(path, part);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (await realpath(path)) !== path) throw unavailable();
    }
    signal.throwIfAborted();
    return path;
  }
  private async recheck(root: Root, path: string, signal: AbortSignal) {
    const current = await this.root(root.group.id, signal, root.folderId);
    if (current.token !== root.token) throw unavailable();
    return this.path(current, path, signal);
  }
  private run<T>(id: string, requestId: string, action: (signal: AbortSignal) => Promise<T>) {
    if (this.shutdown.signal.aborted) return Promise.reject(new RpcError(-32001, "Brain stopping"));
    if (this.requests.size >= 8 || this.requests.has(requestId))
      return Promise.reject(new RpcError(-32011, "File request busy"));
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      this.shutdown.signal,
      AbortSignal.timeout(20_000),
    ]);
    const operation = Promise.resolve()
      .then(() => action(signal))
      .catch((error: unknown) => {
        if (signal.aborted) throw new RpcError(-32001, "File request cancelled");
        if (error instanceof RpcError) throw error;
        if (error instanceof Error && "code" in error) throw unavailable();
        throw error;
      })
      .finally(() => this.requests.delete(requestId));
    this.requests.set(requestId, { groupId: id, abort, operation });
    // Do not release IO ownership early: stop still waits for native reads and their finally cleanup.
    return abortable(operation, signal);
  }
  list(
    params: KernelMethodParams["groups.files.list"],
  ): Promise<KernelMethodResults["groups.files.list"]> {
    return this.run(params.groupId, params.requestId, async (signal) => {
      const relativePath = params.path ?? "";
      const limit = params.limit ?? 50;
      const root = await this.root(params.groupId, signal, params.folderId);
      if (root.access) {
        const path = await this.path(root, relativePath, signal);
        const result = await remoteGroupPage(
          root.access,
          root.token,
          path,
          relativePath,
          limit,
          this.decode(params.cursor),
          (cursor) => this.encode(cursor),
          signal,
        );
        await this.recheck(root, relativePath, signal);
        return result;
      }
      const path = await this.path(root, relativePath, signal);
      const info = await lstat(path, { bigint: true });
      if (!info.isDirectory()) throw unavailable();
      const directory = this.sign(directoryVersion(path, info));
      const before = this.decode(params.cursor);
      if (
        before &&
        (before.root !== root.token ||
          before.directory !== directory ||
          before.path !== relativePath)
      )
        throw unavailable();
      const offset = before?.offset ?? 0;
      const entries: KernelMethodResults["groups.files.list"]["entries"] = [];
      let scanned = 0;
      let more = false;
      signal.throwIfAborted();
      const dir = await opendir(path);
      try {
        // Native directory order is used only while its identity/mtime remain unchanged.
        while (scanned < Math.min(10_000, offset + limit)) {
          signal.throwIfAborted();
          const entry = await dir.read();
          if (!entry) break;
          scanned++;
          if (scanned <= offset) continue;
          if (/[\\:\p{Cc}\p{Cf}]/u.test(entry.name)) continue;
          const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
          if (relative.length > 4096 || relative.split("/").length > 32) continue;
          entries.push({
            name: entry.name,
            path: relative,
            kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "blocked",
          });
        }
        signal.throwIfAborted();
        more = !!(await dir.read());
      } finally {
        await dir.close();
      }
      await this.recheck(root, relativePath, signal);
      const after = await lstat(path, { bigint: true });
      signal.throwIfAborted();
      if (directory !== this.sign(directoryVersion(path, after))) throw unavailable();
      const cursor =
        more && scanned < 10_000
          ? this.encode({
              root: root.token,
              directory,
              path: relativePath,
              offset: scanned,
            })
          : undefined;
      return { entries, rootToken: root.token, cursor, truncated: more && !cursor };
    });
  }
  private encode(value: z.infer<typeof cursorSchema>) {
    const text = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${text}.${this.sign(text)}`;
  }
  private decode(cursor?: string) {
    if (!cursor) return undefined;
    const [text, signature, extra] = cursor.split(".");
    const expected = this.sign(text ?? "");
    if (
      !text ||
      extra ||
      !signature ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))
    )
      throw unavailable();
    try {
      return cursorSchema.parse(JSON.parse(Buffer.from(text, "base64url").toString("utf8")));
    } catch {
      throw unavailable();
    }
  }
  open(params: KernelMethodParams["groups.files.open"]) {
    return this.run(params.groupId, params.requestId, async (signal) => {
      const root = await this.root(params.groupId, signal, params.folderId);
      if (params.rootToken !== root.token) throw unavailable();
      const path = await this.path(root, params.path, signal);
      if (root.access) {
        if ((await root.access.inspect(path, signal))?.kind !== "file") throw unavailable();
        await this.recheck(root, params.path, signal);
        return {
          ok: true as const,
          preview: {
            groupId: params.groupId,
            folderId: params.folderId,
            path: params.path,
            rootToken: root.token,
          },
        };
      }
      if (!(await lstat(path)).isFile()) throw unavailable();
      await this.recheck(root, params.path, signal);
      if (!this.local.deps.host.openPath) throw new RpcError(-32603, "File opener unavailable");
      await abortable(
        this.local.deps.host.openPath({ path, allowedRoots: [root.cwd] }, signal),
        signal,
      );
      return { ok: true as const };
    });
  }
  reveal(groupId: string, parent: AbortSignal, folderId?: string) {
    return this.run(groupId, randomUUID(), async (owned) => {
      const signal = AbortSignal.any([owned, parent]);
      const root = await this.root(groupId, signal, folderId);
      if (root.access) throw new RpcError(RpcErrorCodes.unsupported, "path_reveal_unsupported");
      const host = this.local.deps.host.revealPath;
      if (!host) throw new RpcError(RpcErrorCodes.unsupported, "path_reveal_unsupported");
      await this.recheck(root, "", signal);
      signal.throwIfAborted();
      await host({ path: root.cwd, allowedRoots: [root.cwd] }, signal);
      this.local.approvals.audit.append({
        botId: root.group.coordinatorBotId,
        kind: "file.revealed",
        summary: "Group folder shown / 已定位群文件夹",
        detail: { groupId, actor: "user" },
      });
      return { ok: true as const };
    });
  }
  preview(
    params: KernelMethodParams["groups.files.preview"],
  ): Promise<KernelMethodResults["groups.files.preview"]> {
    return this.run(params.groupId, params.requestId, async (signal) => {
      const root = await this.root(params.groupId, signal, params.folderId);
      if (params.rootToken !== root.token || !root.access) throw unavailable();
      const path = await this.path(root, params.path, signal);
      const result = await remoteGroupPreview(
        root.access,
        root.cwd,
        path,
        params.expectedRevision,
        (text) => this.local.deps.redactor.redact(text),
        signal,
      );
      await this.recheck(root, params.path, signal);
      return result;
    });
  }
  cancel(groupId: string, requestId: string) {
    const request = this.requests.get(requestId);
    if (request?.groupId === groupId) request.abort.abort();
    return { ok: true as const };
  }
  async drainGroup(groupId: string) {
    const owned = [...this.requests.values()].filter((request) => request.groupId === groupId);
    for (const request of owned) request.abort.abort();
    await Promise.allSettled(owned.map((request) => request.operation));
  }
  async stop() {
    this.shutdown.abort();
    await Promise.allSettled([...this.requests.values()].map((request) => request.operation));
  }
  async drainInteractive() {
    this.shutdown.abort();
    await Promise.allSettled([...this.requests.values()].map((request) => request.operation));
    this.shutdown = new AbortController();
  }
}
