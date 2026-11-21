import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Development probe only: keep SDK access inside agent and never price a real provider. */
export function priceFakeModels() {
  const original = ModelRuntime.prototype.registerProvider;
  ModelRuntime.prototype.registerProvider = function (provider, config) {
    return original.call(
      this,
      provider,
      config.name === "本地假模型"
        ? {
            ...config,
            models: config.models?.map((model) => ({
              ...model,
              cost: { input: 10_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          }
        : config,
    );
  };
  return () => {
    ModelRuntime.prototype.registerProvider = original;
  };
}
