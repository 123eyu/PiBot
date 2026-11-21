import type { ToolRunContext } from "../../core/local-types.ts";

/** Only user-visible runs can persist a card that the normal send lane can answer. */
export function canAskUser(context: Partial<ToolRunContext>) {
  return (
    !!context.todoRun && !context.executionTaskId && !context.routineRunId && !context.routineSource
  );
}
