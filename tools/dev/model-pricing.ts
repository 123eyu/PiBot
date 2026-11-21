export interface EvalPricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Custom providers carry no prices in the product, so every request on them has unknown cost,
 * and a cost cap then stops the first request (`price_unknown`). The evals price their own
 * provider by name at pi's registration point, which the main and the auxiliary model share.
 * Returns the restore function; callers restore in `finally`. pi's ModelRuntime is passed in and
 * typed structurally: importing pi's declarations from this root-level file first breaks the
 * type check of packages/agent (its message-type augmentation is then not yet applied).
 */
export function priceEvalProvider<
  Config extends { name?: string; models?: readonly object[] },
  Runtime extends { prototype: { registerProvider(providerId: string, config: Config): void } },
>(runtime: Runtime, providerName: string, pricing: EvalPricing) {
  const register = runtime.prototype.registerProvider;
  runtime.prototype.registerProvider = function (this: unknown, providerId, config) {
    if (config.name === providerName && config.models)
      config = {
        ...config,
        models: config.models.map((model) => ({
          ...model,
          cost: {
            input: pricing.input,
            output: pricing.output,
            cacheRead: pricing.cacheRead,
            cacheWrite: pricing.input,
          },
        })),
      };
    return register.call(this, providerId, config);
  };
  return () => {
    runtime.prototype.registerProvider = register;
  };
}
