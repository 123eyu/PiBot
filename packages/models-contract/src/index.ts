import type { Params, Payload, ProviderSchema, Result } from "@pibot/protocol-base";
import type { z } from "zod";
import type { ModelProviderEvents, ModelProviderMethods } from "./api/methods.ts";

export * from "./api/methods.ts";
export type ModelMethodParams = {
  [K in keyof typeof ModelProviderMethods]: Params<typeof ModelProviderMethods, K>;
};
export type ModelMethodResults = {
  [K in keyof typeof ModelProviderMethods]: Result<typeof ModelProviderMethods, K>;
};
export type ModelEventPayloads = {
  [K in keyof typeof ModelProviderEvents]: Payload<typeof ModelProviderEvents, K>;
};
export type Provider = z.output<typeof ProviderSchema>;
