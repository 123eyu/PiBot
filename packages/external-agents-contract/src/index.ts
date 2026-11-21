import type { Params, Result } from "@pibot/protocol-base";
import type { ExternalAgentMethods } from "./api/methods.ts";

export * from "./agents/catalog.ts";
export * from "./api/methods.ts";
export * from "./api/turn-facts.ts";
export * from "./tools/delegation.ts";
export type ExternalAgentMethodParams = {
  [K in keyof typeof ExternalAgentMethods]: Params<typeof ExternalAgentMethods, K>;
};
export type ExternalAgentMethodResults = {
  [K in keyof typeof ExternalAgentMethods]: Result<typeof ExternalAgentMethods, K>;
};
