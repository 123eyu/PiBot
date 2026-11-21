import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createGitReader,
  createManagedGit,
  type ExecOptions,
  ManagedExecError,
  type ManagedGit,
  type ManagedGitRepository,
  managedWorktreePath,
  prepareManagedProject,
} from "@pibot/execution";
import type {
  ManagedGitPort,
  RunnerManagedGitExecuteParams,
  RunnerManagedGitExecuteResult,
  RunnerManagedGitInspectParams,
  RunnerManagedGitPrepareParams,
} from "@pibot/protocol-base";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { commitManifest } from "./managed-git-manifest.ts";

export { changedPaths, DELETED } from "./managed-git-manifest.ts";

type WireIdentity = { canonicalPath: string; device: string | null; inode: string | null };
type WireRepository = NonNullable<RunnerManagedGitExecuteResult["repository"]>;
type Binding = RunnerManagedGitPrepareParams["binding"];

/** A managed write needs device and inode; without them it is refused, never guessed. */
function identity(value: WireIdentity) {
  if (!value.device || !value.inode)
    throw new RpcError(RpcErrorCodes.dispatchDenied, "managed_git_identity_missing");
  return { path: value.canonicalPath, device: value.device, inode: value.inode };
}
const wireIdentity = (value: ManagedGitRepository["root"]): WireIdentity => ({
  canonicalPath: value.path,
  device: value.device,
  inode: value.inode,
});
const wire = (value: ManagedGitRepository): WireRepository => ({
  root: wireIdentity(value.root),
  git: wireIdentity(value.git),
  common: wireIdentity(value.common),
  head: value.head,
  branch: value.branch,
  clean: value.clean,
});
const failure = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code.slice(0, 80)
    : "managed_git_unsupported";

/**
 * Runner-owned adapter: the wire carries structured operations and identities, never
 * a command, commonDir or write path. Worktree folders are computed here with this machine's path
 * rules, so a Windows path is never built by a macOS control side.
 */
export function createManagedGitPort(
  options: ExecOptions,
  authority: {
    home: string;
    dataDir: string;
    assertAuthorized(): void;
  },
  // The desktop only sees the wire code; the runner log keeps which operation failed and why.
  onFailure?: (event: { operation: string; code: string; managedCode?: string }) => void,
): ManagedGitPort & { dispose(): void } {
  const git: ManagedGit = createManagedGit(options);
  const reader = createGitReader({
    platform: options.platform,
    env: options.env,
    userHome: options.systemHome,
    resourcesDir: options.resourcesDir,
  });
  const sourceRoot = (binding: Binding) => {
    const root = binding.source?.root.canonicalPath;
    if (!root) throw new Error("managed_git_binding_invalid");
    return root;
  };
  /** The repository bound at prepare time must be the same one now (no swap in between). */
  const bound = async (expected: WireRepository, signal: AbortSignal) => {
    const current = await git.inspect(expected.root.canonicalPath, signal);
    const want = identity(expected.root);
    if (
      current.root.device !== want.device ||
      current.root.inode !== want.inode ||
      current.head !== expected.head ||
      current.branch !== expected.branch
    )
      throw new Error("managed_identity_changed");
    return current;
  };
  const destination = (binding: Binding) => {
    if (!binding.managedId) throw new Error("managed_git_binding_invalid");
    const parent = join(sourceRoot(binding), ".pibot", "wt");
    const path = managedWorktreePath(parent, sourceRoot(binding), binding.managedId);
    // The control side computes the same path with this platform's rules; any other is refused.
    if (binding.destination && binding.destination !== path)
      throw new Error("managed_git_destination_mismatch");
    return path;
  };
  const commit = async (
    root: string,
    binding: Binding,
    filesHash: string | undefined,
    signal: AbortSignal,
  ) => {
    const manifest = await commitManifest(reader, root, signal);
    if (!filesHash || manifest.filesHash !== filesHash)
      throw new Error("managed_git_files_changed");
    if (!binding.commit) throw new Error("managed_git_commit_binding_invalid");
    const repository = await git.inspect(root, signal);
    const directory = join(options.tempDir, "managed-git", randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const pathspec = join(directory, "paths"),
        message = join(directory, "message");
      await writeFile(pathspec, manifest.entries.map((entry) => `${entry.path}\0`).join(""), {
        mode: 0o600,
      });
      await writeFile(message, binding.commit.message, { mode: 0o600 });
      await git.writeChanges(
        repository,
        [
          {
            kind: "commit",
            pathspecFile: pathspec,
            messageFile: message,
            name: binding.commit.name,
            email: binding.commit.email,
          },
        ],
        { ...authority, signal },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return git.inspect(root, signal);
  };
  return {
    async inspect(input: RunnerManagedGitInspectParams, signal: AbortSignal) {
      try {
        const value = await git.inspect(input.root, signal);
        return {
          supported: true,
          repository: wire(value),
          ...(input.ancestor
            ? {
                ancestor: await git.ancestor(
                  input.root,
                  input.ancestor.a,
                  input.ancestor.b,
                  signal,
                ),
              }
            : {}),
          ...(input.lock
            ? {
                ownsLock: await git.ownsLock(
                  input.root,
                  input.lock.path,
                  input.lock.managedId,
                  signal,
                ),
              }
            : {}),
        };
      } catch (error) {
        return { supported: false, repository: null, reason: failure(error) };
      }
    },
    async prepare(input: RunnerManagedGitPrepareParams, signal: AbortSignal) {
      const source = input.binding.source;
      if (!source) throw new Error("managed_git_binding_invalid");
      const repository = await bound(source, signal);
      if (input.operation === "create") destination(input.binding);
      const manifest =
        input.operation === "commit"
          ? await commitManifest(reader, repository.root.path, signal)
          : undefined;
      return {
        planId: randomUUID(),
        operation: input.operation,
        repository: wire(repository),
        ...(manifest ? { files: manifest.entries, filesHash: manifest.filesHash } : {}),
      };
    },
    async execute(
      input: RunnerManagedGitExecuteParams & { prepared: RunnerManagedGitPrepareParams },
      signal: AbortSignal,
    ): Promise<RunnerManagedGitExecuteResult> {
      try {
        return await execute(input, signal);
      } catch (error) {
        onFailure?.({
          operation: input.prepared.operation,
          code: failure(error),
          ...(error instanceof ManagedExecError ? { managedCode: error.managedCode } : {}),
        });
        throw error;
      }
    },
    dispose() {
      reader.dispose();
      git.dispose();
    },
  };
  async function execute(
    input: RunnerManagedGitExecuteParams & { prepared: RunnerManagedGitPrepareParams },
    signal: AbortSignal,
  ): Promise<RunnerManagedGitExecuteResult> {
    {
      const binding = input.prepared.binding;
      if (!binding.source) throw new Error("managed_git_binding_invalid");
      const source = await bound(binding.source, signal);
      const write = { ...authority, signal };
      switch (input.prepared.operation) {
        case "commit": {
          const after = await commit(source.root.path, binding, input.filesHash, signal);
          return {
            operation: "commit",
            repository: wire(after),
            integrated: false,
            cleaned: false,
          };
        }
        case "create": {
          const path = destination(binding);
          const parent = await prepareManagedProject(
            source.root,
            signal,
            authority.assertAuthorized,
            source.git,
          );
          await git.write(
            {
              kind: "create",
              source,
              parent,
              destination: path,
              managedId: binding.managedId as string,
              baseHead: binding.expectedSourceHead ?? source.head,
              ...(binding.target ? { base: await bound(binding.target, signal) } : {}),
            },
            write,
          );
          return {
            operation: "create",
            repository: wire(await git.inspect(path, signal)),
            parent: wireIdentity(parent),
            integrated: false,
            cleaned: false,
          };
        }
        case "integrate": {
          if (!binding.target) throw new Error("managed_git_binding_invalid");
          const target = await bound(binding.target, signal);
          await git.write(
            {
              kind: "integrate",
              source,
              target,
              expectedSourceHead: binding.expectedSourceHead ?? source.head,
              expectedTargetHead: binding.expectedTargetHead ?? target.head,
              ...(binding.allowMerge ? { allowMerge: true } : {}),
            },
            write,
          );
          const after = await git.inspect(target.root.path, signal);
          return {
            operation: "integrate",
            repository: wire(after),
            integrated: await git.ancestor(after.root.path, source.head, after.head, signal),
            cleaned: false,
          };
        }
        case "remove": {
          if (!binding.target || !binding.parent || !binding.managedId)
            throw new Error("managed_git_binding_invalid");
          const worktree = await bound(binding.target, signal);
          await git.write(
            {
              kind: "remove",
              source,
              worktree,
              managedId: binding.managedId,
              parent: identity(binding.parent),
              ...(binding.integratedInto
                ? { integratedInto: await bound(binding.integratedInto, signal) }
                : {}),
              ...(binding.preserveBranch ? { preserveBranch: true } : {}),
            },
            write,
          );
          return {
            operation: "remove",
            repository: wire(await git.inspect(source.root.path, signal)),
            integrated: false,
            cleaned: true,
          };
        }
      }
    }
  }
}
