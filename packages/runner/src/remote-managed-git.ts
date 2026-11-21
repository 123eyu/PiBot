import { randomUUID } from "node:crypto";
import type {
  ManagedGitAuthority,
  ManagedGitRepository,
  ManagedGitWrite,
  ManagedPathIdentity,
  RemoteManagedGit,
} from "@pibot/execution";
import {
  type Params,
  type Result,
  RpcError,
  RpcErrorCodes,
  type RunnerManagedGitPrepareParams,
  type RunnerMethods,
} from "@pibot/protocol-base";

/** Fixed codes only (group code shows them); never a path, message or Git output. */
const refused = (code: string) => new RpcError(RpcErrorCodes.invalidParams, code.slice(0, 80));

import { DELETED } from "./managed-git-manifest.ts";

type Binding = RunnerManagedGitPrepareParams["binding"];
type Wire = NonNullable<Binding["source"]>;
type Call = <M extends keyof RunnerMethods>(
  method: M,
  params: Params<RunnerMethods, M>,
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<Result<RunnerMethods, M>>;

const PLAN_LIFETIME_MS = 120_000;
const wireIdentity = (value: ManagedPathIdentity) => ({
  canonicalPath: value.path,
  device: value.device,
  inode: value.inode,
});
const wire = (value: ManagedGitRepository): Wire => ({
  root: wireIdentity(value.root),
  git: wireIdentity(value.git),
  common: wireIdentity(value.common),
  head: value.head,
  branch: value.branch,
  clean: value.clean,
});
/** The runner's identities must be complete; an empty device or inode is refused, never padded. */
function identity(value: { canonicalPath: string; device: string | null; inode: string | null }) {
  if (!value.device || !value.inode) throw refused("managed_git_identity_missing");
  return { path: value.canonicalPath, device: value.device, inode: value.inode };
}
function repository(value: Wire): ManagedGitRepository {
  return {
    root: identity(value.root),
    git: identity(value.git),
    common: identity(value.common),
    head: value.head,
    branch: value.branch,
    clean: value.clean,
  };
}
function binding(operation: ManagedGitWrite): Binding {
  const common = {
    authorizationVersion: "a60",
    expiresAt: new Date(Date.now() + PLAN_LIFETIME_MS).toISOString(),
    source: wire(operation.source),
  };
  switch (operation.kind) {
    case "create":
      // The runner prepares `.pibot/wt` and checks the destination with its own path rules.
      return {
        ...common,
        managedId: operation.managedId,
        destination: operation.destination,
        expectedSourceHead: operation.baseHead,
        ...(operation.base ? { target: wire(operation.base) } : {}),
      };
    case "integrate":
      return {
        ...common,
        target: wire(operation.target),
        expectedSourceHead: operation.expectedSourceHead,
        expectedTargetHead: operation.expectedTargetHead,
        ...(operation.allowMerge ? { allowMerge: true } : {}),
      };
    case "remove":
      return {
        ...common,
        target: wire(operation.worktree),
        managedId: operation.managedId,
        parent: wireIdentity(operation.parent),
        ...(operation.integratedInto ? { integratedInto: wire(operation.integratedInto) } : {}),
        ...(operation.preserveBranch ? { preserveBranch: true } : {}),
      };
  }
}

/**
 * Control side of the runner's managed Git. Every write is prepare → the control
 * side's final authorization (dispatch confirmation) → execute with one idempotency key, so a
 * reconnect asks the runner's journal for the same result instead of repeating the write.
 */
export function createRemoteManagedGit(deps: {
  call: Call;
  callSignal(signal: AbortSignal): AbortSignal;
  withDispatch<T>(confirm: () => void, work: (dispatchOpId: string) => Promise<T>): Promise<T>;
}): RemoteManagedGit {
  const { call, callSignal } = deps;
  const inspect = async (
    root: string,
    signal: AbortSignal,
    extra: { ancestor?: { a: string; b: string }; lock?: { path: string; managedId: string } } = {},
  ) => {
    const result = await call(
      "runner.managedGit.inspect",
      { root, ...extra },
      { signal: callSignal(signal), timeoutMs: 30_000 },
    );
    if (!result.supported || !result.repository)
      throw refused(result.reason ?? "managed_git_unsupported");
    return result;
  };
  const execute = async (
    operation: RunnerManagedGitPrepareParams["operation"],
    params: Binding,
    authority: ManagedGitAuthority,
    files?: (prepared: {
      files?: { path: string; size: number; sha256: string }[];
    }) => Promise<void>,
  ) => {
    const prepared = await call(
      "runner.managedGit.prepare",
      { operation, binding: params },
      { signal: callSignal(authority.signal), timeoutMs: 60_000 },
    );
    if (files) await files(prepared);
    const idempotencyKey = randomUUID();
    const issuedAt = new Date().toISOString();
    return deps.withDispatch(authority.assertAuthorized, (dispatchOpId) =>
      call(
        "runner.managedGit.execute",
        {
          planId: prepared.planId,
          idempotencyKey,
          issuedAt,
          dispatchOpId,
          ...(prepared.filesHash ? { filesHash: prepared.filesHash } : {}),
        },
        { signal: callSignal(authority.signal), timeoutMs: 180_000 },
      ),
    );
  };
  return {
    async inspect(path, signal) {
      return repository((await inspect(path, signal)).repository as Wire);
    },
    async ancestor(cwd, a, b, signal) {
      const result = await inspect(cwd, signal, { ancestor: { a, b } });
      if (result.ancestor === undefined)
        throw new RpcError(RpcErrorCodes.unsupported, "runner_update_required");
      return result.ancestor;
    },
    async ownsLock(cwd, path, managedId, signal) {
      const result = await inspect(cwd, signal, { lock: { path, managedId } });
      return result.ownsLock === true;
    },
    async write(operation, authority) {
      const result = await execute(operation.kind, binding(operation), authority);
      return {
        ...(result.parent ? { parent: identity(result.parent) } : {}),
        integrated: result.integrated,
      };
    },
    async commitReviewed(source, commit, review, authority) {
      const result = await execute(
        "commit",
        {
          authorizationVersion: "a60",
          expiresAt: new Date(Date.now() + PLAN_LIFETIME_MS).toISOString(),
          source: wire(source),
          expectedSourceHead: source.head,
          commit,
        },
        authority,
        async (prepared) => {
          if (!prepared.files?.length) throw refused("managed_git_nothing_to_commit");
          await review(
            prepared.files.map((file) => ({ ...file, deleted: file.sha256 === DELETED })),
            authority.signal,
          );
        },
      );
      if (!result.repository) throw refused("managed_git_commit_unconfirmed");
      return repository(result.repository);
    },
  };
}
