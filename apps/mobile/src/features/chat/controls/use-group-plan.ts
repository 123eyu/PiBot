import { useMemo } from "react";
import { useRuntime } from "../../../runtime/context.tsx";
import {
  continuePlan,
  planView,
  readGroupPlan,
  readGroupTasks,
  retryStep,
  setGroupPaused,
} from "./group-plan.ts";
import { type ChatScope, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/**
 * The group's current plan with live step states, for the strip chip and the task progress
 * sheet. Retry and continue call the same methods as the desktop cards, so both stay identical.
 */
export function useGroupPlan(scope: ChatScope | undefined) {
  const runtime = useRuntime();
  const group = scope?.kind === "group" ? scope : undefined;
  const state = useRemoteValue(
    group ? `groupplan:${scopeKey(group)}` : undefined,
    (signal) => readGroupPlan(runtime, (group as ChatScope).id, signal),
    // A step settling changes its task (group.task); start, replan and stop change the card.
    ["groups.plan.changed", "groups.changed", "group.task"],
  );
  const value = state.value ?? undefined;
  const view = useMemo(() => (value ? planView(value) : undefined), [value]);
  const after = () => void state.load();
  return {
    ...state,
    view,
    retry: (stepId: string) =>
      state.write.run(async (signal) => {
        const workflowRunId = value?.progress?.workflowRunId;
        if (!group || !workflowRunId) return;
        await retryStep(runtime, group.id, workflowRunId, stepId, signal);
        signal.throwIfAborted();
        after();
        return true;
      }),
    continue: () =>
      state.write.run(async (signal) => {
        if (!group || !value) return;
        await continuePlan(runtime, group.id, value.messageId, signal);
        signal.throwIfAborted();
        after();
        return true;
      }),
    /** Maintainers 2026-11-20: the group's pause / continue, same as the desktop bar and header switch. */
    setPaused: (paused: boolean) =>
      state.write.run(async (signal) => {
        if (!group) return;
        await setGroupPaused(runtime, group.id, paused, signal);
        signal.throwIfAborted();
        after();
        return true;
      }),
  };
}
/**
 * Task threads of the group's current topic that are still open. A member's run inside a task
 * asks for approval in its thread, which the group chat does not show, so the chat matches its
 * approval cards against these threads (the desktop shows them on the task's row).
 */
export function useGroupThreads(scope: ChatScope | undefined) {
  const runtime = useRuntime();
  const group = scope?.kind === "group" ? scope : undefined;
  const state = useRemoteValue(
    group ? `groupthreads:${scopeKey(group)}` : undefined,
    async (signal) => {
      const tasks = await readGroupTasks(runtime, (group as ChatScope).id, "open", signal);
      return tasks.map((task) => task.threadConversationId);
    },
    ["group.task", "groups.changed", "approval.requested"],
  );
  return useMemo(() => new Set(state.value ?? []), [state.value]);
}
