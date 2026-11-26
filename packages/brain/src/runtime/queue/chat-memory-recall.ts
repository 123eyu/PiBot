import type { LocalToolPorts } from "@pibot/agent";
import type { MemoryRecallObservation, PersonalMemoryPort } from "../memory/port.ts";

/** Observations are optional and cannot interrupt a user run or change its policy gates. */
export function chatMemoryRecall(
  memory: PersonalMemoryPort | undefined,
  runId: string,
  signal: AbortSignal,
  onError: () => void,
) {
  let reported = false;
  const safely = (action: () => void) => {
    try {
      action();
    } catch {
      if (!reported) {
        reported = true;
        onError();
      }
    }
  };
  const observe = (value: MemoryRecallObservation) => {
    if (!signal.aborted) safely(() => memory?.observeRecall?.(runId, value));
  };
  return {
    observe,
    tools(ports: LocalToolPorts): LocalToolPorts {
      return {
        ...ports,
        execute(call, toolSignal, output) {
          if (!toolSignal.aborted) observe({ kind: "tool", value: call.input });
          return ports.execute(call, toolSignal, output);
        },
      };
    },
    finish() {
      safely(() => memory?.finishRecall?.(runId));
    },
  };
}
