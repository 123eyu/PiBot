import type { Logger } from "@pibot/observability";
import type { RoutineControlSchema } from "@pibot/protocol";

type Control = ReturnType<typeof RoutineControlSchema.parse>;
export function routineOutbox(logger: Logger) {
  const pending: Control[] = [];
  let overflow = false;
  return {
    push(value: Control) {
      if (value.type === "power-snapshot" || value.type === "ui-active") {
        const index = pending.findIndex((entry) => entry.type === value.type);
        if (index >= 0) pending.splice(index, 1);
      }
      if (pending.length >= 128) {
        pending.shift();
        overflow = true;
      }
      pending.push(value);
    },
    flush(send: (value: Control) => void) {
      for (const value of pending.splice(0)) send(value);
      if (overflow) {
        // A bounded outage cannot promise a complete audit; never invent a synthetic power event.
        logger.warn("power input overflow; oldest buffered event unavailable");
        overflow = false;
      }
    },
    clear() {
      pending.length = 0;
      overflow = false;
    },
  };
}
