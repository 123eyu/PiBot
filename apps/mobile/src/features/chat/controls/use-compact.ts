import { useRef } from "react";
import { useLinkState, useRuntime } from "../../../runtime/context.tsx";
import { useAction } from "../../../runtime/use-action.ts";
import { cancelCompact, compact } from "./calls.ts";
import { type ChatScope, isDm, scopeKey } from "./scope.ts";

/** "整理上下文" for a DM topic; the same request ID lets a second tap cancel it. */
export function useCompact(scope: ChatScope | undefined) {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const key = `${mobile.selectedId}:compact:${scopeKey(scope)}`;
  const action = useAction(key, mobile.peer);
  const cancelAction = useAction(key, mobile.peer);
  const request = useRef<string | undefined>(undefined);
  return {
    action,
    cancelAction,
    enabled: !!scope && isDm(scope),
    running: action.busy,
    start: () =>
      action.run(async (signal) => {
        if (!scope || !isDm(scope)) return;
        const id = crypto.randomUUID();
        request.current = id;
        try {
          await compact(runtime, scope, id, signal);
        } finally {
          request.current = undefined;
        }
        signal.throwIfAborted();
        return true;
      }),
    cancel: () =>
      cancelAction.run(async (signal) => {
        const id = request.current;
        if (!scope || !id) return;
        await cancelCompact(runtime, scope, id, signal);
        return true;
      }),
  };
}
