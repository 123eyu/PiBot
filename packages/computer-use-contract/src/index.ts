import type { Params, Payload, Result } from "@pibot/protocol-base";
import type { ComputerEvents, ComputerMethods } from "./api/computer.ts";

export { ComputerEvents, ComputerMethods } from "./api/computer.ts";
export type ComputerMethodParams = {
  [K in keyof typeof ComputerMethods]: Params<typeof ComputerMethods, K>;
};
export type ComputerMethodResults = {
  [K in keyof typeof ComputerMethods]: Result<typeof ComputerMethods, K>;
};
export type ComputerEventPayloads = {
  [K in keyof typeof ComputerEvents]: Payload<typeof ComputerEvents, K>;
};

export * from "./endpoints/catalog.ts";
