import type { KernelRegisterRpc, LocalService } from "@pibot/brain/orchestration-kit";
import { RpcError } from "@pibot/protocol-base";
import { RunsRepo } from "@pibot/storage";

export function registerTaskRpc(handle: KernelRegisterRpc, local: LocalService) {
  const tasks = local.tasks;
  handle("execution.tasks.list", async ({ botId, conversationId, ...page }) =>
    tasks.list({ botId, conversationId }, page),
  );
  handle("execution.tasks.get", async ({ botId, conversationId, taskId }) =>
    tasks.detail({ botId, conversationId }, taskId),
  );
  handle("execution.tasks.history", async ({ botId, conversationId, taskId, ...page }) =>
    tasks.history({ botId, conversationId }, taskId, page),
  );
  handle("execution.tasks.message", async ({ botId, conversationId, taskId, requestId, message }) =>
    tasks.message({ botId, conversationId }, taskId, requestId, message),
  );
  handle("execution.tasks.cancel", async ({ botId, conversationId, taskId }) =>
    tasks.cancel({ botId, conversationId }, taskId),
  );
  // Chains an earlier process left behind run again only on the user's confirmation.
  handle("continuations.list", async ({ after, limit }) =>
    tasks.continuations.restorable(after, limit),
  );
  handle("continuations.resume", async ({ conversationId }, context) =>
    tasks.continuations.resumeRestored(
      conversationId,
      AbortSignal.any([context.signal, local.shutdown.signal, AbortSignal.timeout(20_000)]),
    ),
  );
  handle("continuations.discard", async ({ conversationId }) =>
    tasks.continuations.discardRestored(conversationId),
  );
  handle("execution.budget.get", async ({ botId, conversationId, runId }) => {
    local.execution.get({ botId, conversationId });
    const runs = new RunsRepo(local.deps.db);
    const run = runId ? runs.get(runId) : runs.list({ botId, conversationId }, { limit: 1 })[0];
    if (!run) return null;
    if (run.botId !== botId || run.conversationId !== conversationId)
      throw new RpcError(-32602, "execution_budget_scope_changed");
    return local.budgets.snapshot(tasks.budgetRoot(run)) ?? null;
  });
}
