import type { z } from "zod";
import type { ModelInfoSchema } from "./providers.ts";

type ModelInfo = z.infer<typeof ModelInfoSchema>;

export function defaultModelFor(models: readonly ModelInfo[]): ModelInfo | undefined {
  let cheapest: ModelInfo | undefined;
  let firstNonFree: ModelInfo | undefined;
  for (const model of models) {
    // Free endpoints can have stricter limits, so prefer a priced alternative when available.
    if (model.cost.input === 0 && model.cost.output === 0) continue;
    firstNonFree ??= model;
    if (model.cost.input === null) continue;
    if (
      !cheapest ||
      cheapest.cost.input === null ||
      model.cost.input < cheapest.cost.input ||
      (model.cost.input === cheapest.cost.input &&
        (model.cost.output ?? Infinity) < (cheapest.cost.output ?? Infinity))
    )
      cheapest = model;
  }
  return cheapest ?? firstNonFree ?? models[0];
}
