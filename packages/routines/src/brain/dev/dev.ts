import { randomUUID } from "node:crypto";
import {
  type RoutineDevControl,
  RoutineDevControlSchema,
  RoutineTimingSchema,
} from "@pibot/protocol";
import { RoutineDevStateRepo } from "../../store/index.ts";
import type { RoutineService } from "../service.ts";

export type RoutineDevAdapter = (
  service: RoutineService,
) => (input: RoutineDevControl) => Promise<void>;
// Import only from a compile-time development entry; no renderer method registers this adapter.
export const createRoutineDevControl: RoutineDevAdapter = (service) => {
  return async (raw: RoutineDevControl) => {
    const input = RoutineDevControlSchema.parse(raw);
    if (input.type === "dev-routine-timing")
      service.timing = RoutineTimingSchema.parse({ ...service.timing, ...input.patch });
    else if (input.type === "dev-ui-active") {
      new RoutineDevStateRepo(service.deps.db, { dev: true }).setUiActive(input.lastActiveAt);
    } else if (input.type === "dev-check-away") await service.host.checkAway(Date.now(), true);
    else
      await service.host.control(
        input.event
          ? {
              type: "power-event",
              event: { id: randomUUID(), kind: input.event, at: input.at },
              supply: input.supply,
            }
          : {
              type: "power-snapshot",
              supply: input.supply,
              keepAwake: "unsupported",
              at: input.at,
            },
      );
  };
};
