import type { KernelRegisterRpc, LocalService } from "@pibot/brain/orchestration-kit";
import { type ExecutionCollectionChange, RpcError } from "@pibot/protocol-base";
import {
  ExecutionCollectionRepo,
  ExecutionConflictError,
  TaskConflictError,
  transaction,
} from "@pibot/storage";

/** Synchronous admission and transaction leave no await gap for a new run to enter. */
export function registerExecutionCollectionRpc(handle: KernelRegisterRpc, local: LocalService) {
  const repo = new ExecutionCollectionRepo(local.deps.db);
  handle("execution.plans.archived", async ({ botId, conversationId, ...page }) => {
    local.execution.get({ botId, conversationId });
    return repo.plans({ botId, conversationId }, page);
  });
  handle("execution.collection.change", async (change: ExecutionCollectionChange) => {
    local.shutdown.signal.throwIfAborted();
    const scope = { botId: change.botId, conversationId: change.conversationId };
    local.tasks.assertCollectionIdle(scope);
    let result: { tasks?: ReturnType<typeof repo.tasks>; plan?: ReturnType<typeof repo.plan> };
    try {
      result = transaction(local.deps.db, () => {
        local.tasks.assertCollectionIdle(scope);
        const value =
          change.kind === "plan" ? { plan: repo.plan(change) } : { tasks: repo.tasks(change) };
        local.approvals.audit.append({
          botId: change.botId,
          kind: change.kind === "plan" ? "execution.todo.changed" : "execution.task.changed",
          summary: "Execution collection changed",
          detail: {
            conversationId: change.conversationId,
            ...(change.id ? { target: change.id } : {}),
            actor: "user",
            reasonCode: `${change.kind}_${change.action}`,
          },
        });
        return value;
      });
    } catch (error) {
      if (error instanceof ExecutionConflictError || error instanceof TaskConflictError)
        throw new RpcError(-32602, "execution_collection_changed");
      throw error;
    }
    if (result.plan) local.deps.peer.emit("execution.todo.changed", result.plan);
    for (const task of result.tasks ?? []) local.deps.peer.emit("execution.task.changed", task);
    local.deps.peer.emit("execution.collection.changed", {
      botId: change.botId,
      conversationId: change.conversationId,
    });
    return { ok: true as const };
  });
}
