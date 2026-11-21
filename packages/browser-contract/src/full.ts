import {
  KernelEvents,
  KernelMethods,
  type Params,
  type Payload,
  type Result,
} from "@pibot/protocol-base";
import { BrowserContractEvents, BrowserContractMethods } from "./index.ts";

export * from "@pibot/protocol-base";
export * from "./index.ts";
export const Methods = { ...KernelMethods, ...BrowserContractMethods } as const;
export const Events = { ...KernelEvents, ...BrowserContractEvents } as const;
export type MethodParams = { [K in keyof typeof Methods]: Params<typeof Methods, K> };
export type MethodResults = { [K in keyof typeof Methods]: Result<typeof Methods, K> };
export type EventPayloads = { [K in keyof typeof Events]: Payload<typeof Events, K> };
