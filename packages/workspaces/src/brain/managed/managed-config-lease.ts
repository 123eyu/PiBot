import type { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ChangesScope, ManagedConfigOwnerProof, WorkspaceLocal } from "@pibot/brain/kit";
import { matchesFileIdentity } from "@pibot/execution";
import { ManagedWorktreesRepo } from "@pibot/storage";
import { managedError } from "./managed-resource-ports.ts";

const cleanupFailed = (error: unknown) =>
  !!error && typeof error === "object" && "reason" in error && error.reason === "cleanup_failed";
interface LeaseDeps {
  current: AsyncLocalStorage<string>;
  held: Map<string, { botId: string; paths: string[]; failed: boolean }>;
  reserve(botId: string): () => void;
  revision(): string;
  captureQueue(): () => void;
  assertIdle(
    scope: ChangesScope,
    paths: string[],
    signal: AbortSignal,
    owner: ManagedConfigOwnerProof,
  ): Promise<void>;
}

export function configurationActivityPaths(
  local: WorkspaceLocal,
  path: string,
  owner: ManagedConfigOwnerProof | undefined,
) {
  if (!owner) return [path];
  const value = new ManagedWorktreesRepo(local.deps.db).byPath(path);
  if (value) {
    const expected = value.identity?.common;
    if (!expected) managedError("managed_resource_busy", "busy");
    const now = lstatSync(expected.path, { bigint: true });
    if (
      !now.isDirectory() ||
      now.isSymbolicLink() ||
      realpathSync(expected.path) !== expected.path ||
      !matchesFileIdentity(now, expected)
    )
      managedError("managed_resource_busy", "busy");
    return [path, expected.path];
  }
  // An unregistered linked root may share metadata without a trustworthy family identity.
  try {
    const git = lstatSync(join(path, ".git"));
    if (git.isFile() || git.isSymbolicLink()) managedError("managed_resource_busy", "busy");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return [path];
}

export async function configurationPublicationLease<T>(
  deps: LeaseDeps,
  scope: ChangesScope,
  paths: string[],
  owner: ManagedConfigOwnerProof,
  signal: AbortSignal,
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  owner.assertCurrentOwner();
  await deps.assertIdle(scope, paths, signal, owner);
  await owner.acquirePublicationRoots(signal);
  const id = randomUUID(),
    release = deps.reserve(scope.botId);
  const entry = { botId: scope.botId, paths, failed: false };
  deps.held.set(id, entry);
  try {
    return await deps.current.run(id, async () => {
      await deps.assertIdle(scope, paths, signal, owner);
      const revision = deps.revision(),
        assertQueue = deps.captureQueue();
      const result = await operation(() => {
        signal.throwIfAborted();
        owner.assertCurrentOwner();
        assertQueue();
        if (revision !== deps.revision() || !deps.held.has(id))
          managedError("managed_resource_busy", "busy");
      });
      if (
        result &&
        typeof result === "object" &&
        "cleanup" in result &&
        result.cleanup === "required"
      )
        entry.failed = true;
      return result;
    });
  } catch (error) {
    if (
      cleanupFailed(error) ||
      (error &&
        typeof error === "object" &&
        "publication" in error &&
        error.publication === "unconfirmed")
    )
      entry.failed = true;
    throw error;
  } finally {
    if (!deps.held.get(id)?.failed) deps.held.delete(id);
    release();
    // The original LocalRun retains its pinned locks until its existing drain chain completes.
  }
}
