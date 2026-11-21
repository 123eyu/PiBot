import { useRuntime } from "../../../runtime/context.tsx";
import { readPlan } from "./calls.ts";
import { type ChatScope, isDm, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/** Read-only view of the DM topic's todo plan. */
export function usePlan(scope: ChatScope | undefined) {
  const runtime = useRuntime();
  const state = useRemoteValue(
    scope && isDm(scope) ? `plan:${scopeKey(scope)}` : undefined,
    (signal) => readPlan(runtime, scope as ChatScope, signal),
    ["execution.todo.changed"],
  );
  const items = state.value?.items.filter((item) => item.status !== "cancelled") ?? [];
  return {
    ...state,
    items,
    done: items.filter((item) => item.status === "done").length,
  };
}
