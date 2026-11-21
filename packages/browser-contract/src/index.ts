import type { Params, Payload, Result } from "@pibot/protocol-base";
import { BrowserDebugMethods, BrowserEvents, BrowserMethods } from "./api/browser.ts";
import { BrowserExtensionEvents, BrowserExtensionMethods } from "./api/extension-status.ts";

export * from "./api/browser.ts";
export * from "./api/remote-port.ts";

export const BrowserContractMethods = {
  ...BrowserMethods,
  ...BrowserDebugMethods,
  ...BrowserExtensionMethods,
} as const;
export const BrowserContractEvents = { ...BrowserEvents, ...BrowserExtensionEvents } as const;
export type BrowserMethodParams = {
  [K in keyof typeof BrowserContractMethods]: Params<typeof BrowserContractMethods, K>;
};
export type BrowserMethodResults = {
  [K in keyof typeof BrowserContractMethods]: Result<typeof BrowserContractMethods, K>;
};
export type BrowserEventPayloads = {
  [K in keyof typeof BrowserContractEvents]: Payload<typeof BrowserContractEvents, K>;
};

export * from "./api/extension.ts";
export * from "./api/extension-status.ts";
export * from "./endpoints/catalog.ts";
