import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

/** Finishing an assignment ends its follow-through; only a real unfinished plan needs a checkpoint. */
export function taskCompleted(local: LocalService, context: ToolRunContext) {
  const state = context.todoRun;
  if (!state) return;
  state.completedTask = true;
  const plan =
    context.conversationId && state.armed
      ? local.execution.todo({ botId: context.botId, conversationId: context.conversationId })
      : undefined;
  if (plan?.items.some((item) => item.status === "pending" || item.status === "in_progress")) {
    state.paused = { reason: "checkpoint", summary: "" };
    local.noteParentContinuation(context);
  }
}
