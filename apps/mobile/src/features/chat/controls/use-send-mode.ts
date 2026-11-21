import type { ChatAdditionMode, ExecutionMode } from "@pibot/protocol";
import { useState } from "react";
import { useRuntime } from "../../../runtime/context.tsx";
import { readMode, setMode } from "./calls.ts";
import { type ChatScope, isDm, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/**
 * "执行 ▾": the DM topic's execution mode (stored on the computer, like the desktop send options)
 * and how a message written while the Bot is busy is delivered (steer or queue, chosen per send).
 */
export function useSendMode(scope: ChatScope | undefined) {
  const runtime = useRuntime();
  const enabled = !!scope && isDm(scope);
  const [busyMode, setBusyMode] = useState<ChatAdditionMode>("steer");
  const state = useRemoteValue(
    enabled ? `mode:${scopeKey(scope)}` : undefined,
    (signal) => readMode(runtime, scope as ChatScope, signal),
    ["execution.changed"],
  );
  return {
    ...state,
    enabled,
    mode: (state.value?.mode ?? "execute") as ExecutionMode,
    busyMode,
    setBusyMode,
    change: (mode: ExecutionMode) =>
      state.write.run(async (signal) => {
        const current = state.value;
        if (!scope || !current || current.mode === mode) return;
        const next = await setMode(runtime, scope, mode, current.version, signal);
        signal.throwIfAborted();
        state.setValue(next);
      }),
  };
}
