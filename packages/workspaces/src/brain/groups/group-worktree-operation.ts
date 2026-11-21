import { randomUUID } from "node:crypto";
import type { ManagedGitAuthority, ManagedGitWrite } from "@pibot/execution";
import type { ManagedRecord } from "@pibot/storage";
import { isManagedCleanupFailure, preserveManagedFailure } from "../managed/managed-failure.ts";
import type { WorkspaceOperations } from "./group-worktree-create.ts";
import type { WorktreeHost } from "./group-worktree-host.ts";

/** A crash must leave an operation intent, never an inferred successful integration. */
export async function groupWorktreeOperation(
  owner: WorkspaceOperations,
  host: WorktreeHost,
  tree: ManagedRecord,
  operation: ManagedGitWrite,
  authority: ManagedGitAuthority,
) {
  const id = randomUUID();
  owner.registry.intent(id, tree.id, operation.kind, {
    sourceHead: operation.source.head,
    targetHead: operation.kind === "integrate" ? operation.target.head : null,
  });
  try {
    owner.registry.settle(id, "running");
    const result = await host.write(operation, authority);
    owner.registry.settle(id, "done");
    return result;
  } catch (error) {
    throw preserveManagedFailure(error, [
      () =>
        owner.registry.settle(
          id,
          isManagedCleanupFailure(error) || authority.signal.aborted ? "interrupted" : "conflict",
        ),
    ]);
  }
}
