import { useRuntime, useText } from "../../../runtime/context.tsx";
import { confirmLocally } from "../../../runtime/local-auth.ts";
import { readChanges, restoreFile } from "./calls.ts";
import { type ChatScope, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/** Files changed by the topic's latest changing turn; restoring one needs the phone unlocked. */
export function useChanges(scope: ChatScope | undefined) {
  const runtime = useRuntime(),
    t = useText();
  const state = useRemoteValue(
    scope ? `changes:${scopeKey(scope)}` : undefined,
    (signal) => readChanges(runtime, scope as ChatScope, signal),
    ["changes.changed", "chat.done"],
  );
  const files = state.value?.files ?? [];
  return {
    ...state,
    files,
    restorable: state.value?.checkpoint?.state === "retained",
    restore: (path: string) =>
      state.write.run(async (signal) => {
        const turn = state.value;
        if (!scope || !turn) return;
        await confirmLocally(t("unlockRestore"), t("cancel"), signal);
        const receipt = await restoreFile(runtime, scope, turn, path, signal);
        signal.throwIfAborted();
        void state.load();
        return receipt.state === "done" ? "done" : "partial";
      }),
  };
}
