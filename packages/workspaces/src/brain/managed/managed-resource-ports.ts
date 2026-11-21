import type { RunChangesPort } from "@pibot/brain/kit";
import type { ExecOptions, ExecutionTarget } from "@pibot/execution";
import type { ManagedRecord } from "@pibot/storage";
import { type ChangesTarget, RpcError, RpcErrorCodes } from "@pibot/workspaces-contract/full";
import type { ChangesScope } from "../changes/changes-scope.ts";

export type ManagedAction =
  | "inspect"
  | "allocate"
  | "create"
  | "bind"
  | "integrate"
  | "remove"
  | "checkpoint_create"
  | "changes_write"
  | "checkpoint_restore";
export interface ManagedResourcePorts {
  dataDir: string;
  execOptions: ExecOptions;
  target: ExecutionTarget;
  snapshot?<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
  snapshotBudget?: RunChangesPort["snapshotBudget"];
  scope(target: ChangesTarget, signal: AbortSignal): Promise<ChangesScope>;
  /** Policy + current/frozen Plan + current roots; no callback means no execution. */
  authorize(
    scope: ChangesScope,
    action: ManagedAction,
    paths: string[],
    signal: AbortSignal,
  ): Promise<{ assertAuthorized(): void }>;
  /** Source and target topics, AF6 descendants, retained cleanup, background servers and user browser ownership. */
  assertIdle(scope: ChangesScope, paths: string[], signal: AbortSignal): Promise<void>;
  /** Same nested-root locks as tool execution; cleanup_failed must retain the lease, never finally-release it. */
  exclusive<T>(
    scope: ChangesScope,
    paths: string[],
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T>;
  /** Trusted UI only. Must record registry reference in the same DB transaction as primary-root binding. */
  bindRoot(
    scope: ChangesScope,
    tree: ManagedRecord,
    recordReference: () => void,
    signal: AbortSignal,
    restoreSource?: boolean,
  ): Promise<void>;
  /** Fresh actual topic/group/child references; registry rows alone are not sufficient for deletion. */
  referenced(path: string, signal: AbortSignal): Promise<boolean>;
  audit(
    scope: ChangesScope,
    action: ManagedAction,
    state: "started" | "done" | "error",
    operationId: string,
  ): void;
  changed(scope: ChangesScope, runId?: string): void;
}
export const managedScopeKey = (scope: Pick<ChangesScope, "conversationKey" | "topicId">) =>
  `${scope.conversationKey}|${scope.topicId ?? ""}`;
export function managedError(
  reason: string,
  kind: "invalid" | "busy" | "unsupported" = "invalid",
): never {
  throw new RpcError(
    kind === "busy"
      ? RpcErrorCodes.busy
      : kind === "unsupported"
        ? RpcErrorCodes.unsupported
        : RpcErrorCodes.invalidParams,
    reason,
  );
}
export function primaryManagedScope(scope: ChangesScope) {
  if (
    scope.root.role !== "primary" ||
    scope.root.id !== scope.primary.id ||
    scope.boundaryConflict ||
    scope.nestedReadonly ||
    !scope.root.device ||
    !scope.root.inode
  )
    managedError("managed_readonly_root");
  return {
    path: scope.primary.path,
    device: scope.primary.device as string,
    inode: scope.primary.inode as string,
  };
}

/** Selected roots may restore their own checkpoints, without becoming the worktree source. */
export function writableManagedScope(scope: ChangesScope) {
  const root = scope.root;
  if (
    root.role === "readonly" ||
    !scope.roots.some((r) => r.id === root.id && r.path === root.path && r.role === root.role) ||
    scope.boundaryConflict ||
    scope.nestedReadonly ||
    !root.device ||
    !root.inode
  )
    managedError("managed_readonly_root");
  return { path: root.path, device: root.device, inode: root.inode };
}
