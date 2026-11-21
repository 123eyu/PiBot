import type { Params, Result } from "@pibot/protocol-base";
import type { ImageArtifactMethods } from "./api/methods.ts";

export * from "./api/methods.ts";
export type ImageMethodParams = {
  [K in keyof typeof ImageArtifactMethods]: Params<typeof ImageArtifactMethods, K>;
};
export type ImageMethodResults = {
  [K in keyof typeof ImageArtifactMethods]: Result<typeof ImageArtifactMethods, K>;
};
