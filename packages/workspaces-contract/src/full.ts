import {
  KernelEvents,
  KernelMethods,
  type Params,
  type Payload,
  type Result,
} from "@pibot/protocol-base";
import { ChangesEvents, WorkspacesContractMethods } from "./index.ts";

export * from "@pibot/protocol-base";
export * from "./index.ts";
export const Methods = { ...KernelMethods, ...WorkspacesContractMethods } as const;
export const Events = { ...KernelEvents, ...ChangesEvents } as const;
export type MethodParams = { [K in keyof typeof Methods]: Params<typeof Methods, K> };
export type MethodResults = { [K in keyof typeof Methods]: Result<typeof Methods, K> };
export type EventPayloads = { [K in keyof typeof Events]: Payload<typeof Events, K> };
