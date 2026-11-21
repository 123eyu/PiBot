import { RoutineDevControlSchema } from "@pibot/protocol";
import { createRoutineDevControl } from "@pibot/routines/dev";
import { createControlSource } from "./control-source.ts";

// This module is reachable only from the serve-time build branch.
export function devControls(failed: () => void) {
  const source = createControlSource<import("@pibot/protocol").RoutineDevControl>(
    () => undefined,
    failed,
  );
  return {
    source,
    routineDev: createRoutineDevControl,
    receive: (raw: unknown) => source.push(RoutineDevControlSchema.parse(raw)),
  };
}
