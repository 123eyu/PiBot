import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { WorkspaceLocal as LocalService, WorktreeReceipt } from "@pibot/brain/kit";
import {
  createGitReader,
  managedIdentity,
  matchesFileIdentity,
  sensitiveReadBoundary,
} from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { type ManagedIdentity, ManagedWorktreesRepo } from "@pibot/storage";
import {
  ManagedWorktreeSchema,
  RpcError,
  type WorktreeView,
} from "@pibot/workspaces-contract/full";
import type { ChangesRoot } from "../changes-scope.ts";

export type { WorktreeReceipt } from "@pibot/brain/kit";

const same = (a: ManagedIdentity, b: ManagedIdentity) =>
  a.path === b.path && a.device === b.device && a.inode === b.inode;
function gitPointer(root: string) {
  const path = join(root, ".git"),
    info = lstatSync(path);
  if (info.isDirectory() && !info.isSymbolicLink()) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192)
    throw new RpcError(-32602, "worktree_identity_changed");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(fd).size > 8192) throw new RpcError(-32602, "worktree_identity_changed");
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function assertWorktreeReceipt(receipt: WorktreeReceipt) {
  for (const identity of [receipt.source, receipt.root, receipt.git, receipt.common]) {
    const info = lstatSync(identity.path, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(identity.path) !== identity.path ||
      !matchesFileIdentity(info, identity)
    )
      throw new RpcError(-32602, "worktree_identity_changed");
  }
  if (gitPointer(receipt.root.path) !== receipt.gitPointer)
    throw new RpcError(-32602, "worktree_identity_changed");
}
function stableId(common: ManagedIdentity, path: string) {
  const value = createHash("sha256")
    .update(JSON.stringify([common, path]))
    .digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
async function probe(local: LocalService, path: string, signal: AbortSignal) {
  const reader = createGitReader(local.deps);
  const result = await reader
    .run({ op: "probe" }, { cwd: path, signal, timeoutMs: 10_000, maxBytes: 32_768 })
    .finally(() => reader.dispose());
  const [root, git, common, , prefix = ""] = result.stdout.toString("utf8").trimEnd().split("\n");
  if (result.exitCode !== 0 || result.overflow || root !== path || !git || !common || prefix)
    throw new RpcError(-32602, "worktree_identity_changed");
  const identities = await Promise.all([root, git, common].map(managedIdentity));
  return {
    root: identities[0] as ManagedIdentity,
    git: identities[1] as ManagedIdentity,
    common: identities[2] as ManagedIdentity,
  };
}
/** Fixed porcelain records are discovery only, never a management or execution capability. */
export async function discoverWorktrees(
  local: LocalService,
  primary: ChangesRoot,
  signal: AbortSignal,
) {
  let project: Awaited<ReturnType<typeof probe>>;
  try {
    project = await probe(local, primary.path, signal);
  } catch {
    signal.throwIfAborted();
    return [];
  }
  const reader = createGitReader(local.deps);
  const result = await reader
    .run({ op: "worktrees" }, { cwd: primary.path, signal, timeoutMs: 10_000, maxBytes: 1_048_576 })
    .finally(() => reader.dispose());
  if (result.exitCode !== 0 || result.overflow)
    throw new RpcError(-32602, "worktree_discovery_unavailable");
  const protectedPaths = await sensitiveReadBoundary(
    local.deps.platform,
    [local.deps.userHome],
    local.deps.env,
  );
  const managed = new Map(
    new ManagedWorktreesRepo(local.deps.db)
      .project(project.common.path)
      .map((value) => [value.path, value]),
  );
  const output: { view: WorktreeView; receipt: WorktreeReceipt }[] = [];
  const records = result.stdout.toString("utf8").split("\0\0").filter(Boolean);
  if (records.length > 250) throw new RpcError(-32602, "worktree_discovery_limit");
  for (const record of records) {
    signal.throwIfAborted();
    const fields = record.split("\0"),
      path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!path || fields.includes("bare") || /[\0\r\n]/.test(path)) continue;
    if (
      containsPath(local.deps.dataDir, path, local.deps.platform) &&
      !containsPath(primary.path, path, local.deps.platform)
    )
      continue;
    if (
      protectedPaths.denyRead.some((root) => containsPath(root, path, local.deps.platform)) &&
      !protectedPaths.allowRead.some((root) => containsPath(root, path, local.deps.platform))
    )
      continue;
    let identity: ManagedIdentity;
    try {
      identity = await managedIdentity(path);
    } catch {
      signal.throwIfAborted();
      continue;
    }
    const item = managed.get(path),
      rootId = item?.id ?? stableId(project.common, path);
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? null;
    output.push({
      view: {
        rootId,
        path,
        name: basename(path),
        branch:
          fields
            .find((field) => field.startsWith("branch "))
            ?.slice(7)
            .replace(/^refs\/heads\//, "") ?? null,
        head: head && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) ? head : null,
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
        prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
        isMain: record === records[0],
        ...(item
          ? {
              managed: ManagedWorktreeSchema.strip().parse(item),
              ...(item.groupId
                ? { groupId: item.groupId, sourceConversationId: item.sourceConversationId }
                : {}),
            }
          : {}),
        capabilities: {
          view: true,
          review: true,
          integrate: false,
          remove: false,
          reason: item ? "worktree_other_scope" : "worktree_external_readonly",
        },
      },
      receipt: {
        rootId,
        source: project.root,
        root: identity,
        git: item?.identity?.git ?? project.git,
        common: project.common,
        gitPointer: null,
      },
    });
  }
  return output.sort(
    (a, b) =>
      Number(b.view.isMain) - Number(a.view.isMain) || a.view.rootId.localeCompare(b.view.rootId),
  );
}
export async function verifyWorktreeReceipt(
  local: LocalService,
  receipt: WorktreeReceipt,
  signal: AbortSignal,
  pinGit = false,
) {
  const [source, selected] = await Promise.all([
    probe(local, receipt.source.path, signal),
    probe(local, receipt.root.path, signal),
  ]);
  if (
    !same(source.root, receipt.source) ||
    !same(source.common, receipt.common) ||
    !same(selected.root, receipt.root) ||
    !same(selected.common, receipt.common) ||
    (pinGit && !same(selected.git, receipt.git))
  )
    throw new RpcError(-32602, "worktree_identity_changed");
  const next = { ...receipt, git: selected.git, gitPointer: gitPointer(selected.root.path) };
  if (pinGit && next.gitPointer !== receipt.gitPointer)
    throw new RpcError(-32602, "worktree_identity_changed");
  assertWorktreeReceipt(next);
  return next;
}
export async function worktreeViews(
  local: LocalService,
  primary: ChangesRoot,
  _botId: string,
  _groupId: string | undefined,
  _conversationId: string | undefined,
  selected: string | undefined,
  signal: AbortSignal,
): Promise<ChangesRoot[]> {
  const rows = await discoverWorktrees(local, primary, signal);
  const chosen = rows.find((row) => row.view.rootId === selected);
  if (chosen) {
    const actual = await verifyWorktreeReceipt(local, chosen.receipt, signal);
    const item = new ManagedWorktreesRepo(local.deps.db).get(chosen.view.rootId);
    if (
      item?.identity &&
      (!same(actual.root, item.identity.root) ||
        !same(actual.git, item.identity.git) ||
        !same(actual.common, item.identity.common))
    )
      throw new RpcError(-32602, "worktree_identity_changed");
  }
  return rows.map(({ view, receipt }) => ({
    id: view.rootId,
    name: view.name,
    path: view.path,
    role: "readonly",
    kind: "worktree",
    device: receipt.root.device,
    inode: receipt.root.inode,
  }));
}
