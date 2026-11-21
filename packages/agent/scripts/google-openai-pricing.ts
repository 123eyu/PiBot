import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Manual probe only: price the local fixture, never a real provider. */
export function priceGoogleFakeModels() {
  const original = ModelRuntime.prototype.registerProvider;
  ModelRuntime.prototype.registerProvider = function (id, config) {
    return original.call(
      this,
      id,
      config.name === "本地假模型"
        ? {
            ...config,
            models: config.models?.map((model) => ({
              ...model,
              cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
            })),
          }
        : config,
    );
  };
  return () => {
    ModelRuntime.prototype.registerProvider = original;
  };
}
