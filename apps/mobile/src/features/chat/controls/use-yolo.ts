import { useRuntime, useText } from "../../../runtime/context.tsx";
import { confirmLocally } from "../../../runtime/local-auth.ts";
import { readYolo, setYolo } from "./calls.ts";
import { type ChatScope, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/** The topic's YOLO switch; turning it on needs the phone unlocked first. */
export function useYolo(scope: ChatScope | undefined) {
  const runtime = useRuntime(),
    t = useText();
  const state = useRemoteValue(
    scope ? `yolo:${scopeKey(scope)}` : undefined,
    (signal) => readYolo(runtime, scope as ChatScope, signal),
    ["conversations.yolo.changed"],
  );
  const change = (enabled: boolean) =>
    state.write.run(async (signal) => {
      if (!scope) return;
      if (enabled) await confirmLocally(t("unlockYolo"), t("cancel"), signal);
      const next = await setYolo(runtime, scope, enabled, signal);
      signal.throwIfAborted();
      state.setValue(next);
      return next.enabled;
    });
  return {
    ...state,
    enabled: !!state.value?.enabled,
    turnOn: () => change(true),
    turnOff: () => change(false),
  };
}
