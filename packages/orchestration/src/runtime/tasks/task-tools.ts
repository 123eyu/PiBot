import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  RpcError,
  TaskCancelSchema,
  TaskMessageSchema,
  type TaskSpawn,
  TaskSpawnSchema,
  TaskStatusInputSchema,
} from "@pibot/protocol-base";
import type { TaskService } from "./task-service.ts";

export async function executeTaskTool(
  service: TaskService,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
): Promise<LocalToolResult> {
  try {
    await service.guard(context, signal);
    const source = service.source(context);
    if (!source.conversationId) throw new RpcError(-32602, "task_scope_unavailable");
    const scope = { botId: source.botId, conversationId: source.conversationId };
    let result: unknown;
    if (call.tool === "task_spawn") {
      const input = TaskSpawnSchema.parse(call.input);
      const task = await service.spawn(context, call.id, input, signal);
      result = {
        task,
        ...childModelNote(service, context, input, task.id),
        scheduling:
          "Independent task. Update the authorized TODO plan, then use todo_pause reason=waiting_tasks and finish this turn to release shared write ownership. Pi Bot checks results and continues that parent's authorized unfinished plan after children drain; genuine needs_user/review/checkpoint/blocked pauses remain stopped. Do not compete with children for the same write folder or repeatedly poll while holding it.",
      };
    } else if (call.tool === "task_status")
      result = service.status(context, TaskStatusInputSchema.parse(call.input));
    else if (call.tool === "task_message") {
      const input = TaskMessageSchema.parse(call.input);
      result = await service.message(scope, input.taskId, call.id, input.message, context);
    } else result = service.cancel(scope, TaskCancelSchema.parse(call.input).taskId, context);
    return { text: JSON.stringify(result) };
  } catch (error) {
    // Static business reasons are safe, recoverable tool feedback; programming errors still reach
    // the shared execution boundary and its redacted logger.
    if (error instanceof RpcError && /^task_[a-z_]+$/.test(error.message))
      return {
        text: `子任务未执行 / Task action was not performed: ${error.message}`,
        isError: true,
      };
    throw error;
  }
}

/**
 * What the model asked for and what the child got. Outside a workflow run the argument is
 * ignored (not refused), so a habit learned in a workflow never fails an ordinary spawn.
 */
function childModelNote(
  service: TaskService,
  context: ToolRunContext,
  input: TaskSpawn,
  taskId: string,
): { model?: string } {
  if (input.model !== "cheap") return {};
  if (service.tasks.internal(taskId)?.authority.modelTier === "cheap")
    return {
      model:
        "cheap: the child runs on the auxiliary model and spends from this workflow's budget. If that model has no prices under a cost cap, it runs on the main model.",
    };
  if (!context.workflowSkillId || context.executionTaskId)
    return { model: "main: model is only chosen in a workflow run; ignored here." };
  return { model: "main: no auxiliary model is configured, so the child runs on the main model." };
}
