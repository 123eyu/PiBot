import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  type CustomModel,
  type CustomModelCapabilities,
  CustomModelSchema,
  type ResolvedCustomModel,
  ThinkingLevelSchema,
} from "@pibot/protocol-base";

// Duplicate IDs in aggregators must not win over the originating provider by catalog order.
const origins = ["openai", "anthropic", "deepseek", "google", "mistral", "xai"];

/** `inferredFrom.provider` of a limit estimated from the model family, not read from a catalog. */
export const FAMILY_ESTIMATE = "family";

/** Conservative limits for endpoint names absent from pi's provider catalog. */
export function inferCustomModelLimits(id: string) {
  const name = id.toLowerCase().split("/").pop() ?? id.toLowerCase();
  // `family` is the matched prefix (gpt-6, claude, deepseek...), shown as the estimate's source.
  const large = name.match(/^(gpt-[56]|o[134]|claude|gemini)/);
  if (large?.[1]) return { contextWindow: 131_072, maxTokens: 16_384, family: large[1] };
  const mid = name.match(/^(deepseek|qwen|kimi|moonshot|glm)/);
  if (mid?.[1]) return { contextWindow: 65_536, maxTokens: 8_192, family: mid[1] };
  return { contextWindow: 131_072, maxTokens: 16_384, family: "unknown" };
}

export function modelThinkingLevels(model: Model<Api>): CustomModelCapabilities["thinkingLevels"] {
  const supported = new Set(getSupportedThinkingLevels(model));
  const levels = ThinkingLevelSchema.options.filter((level) => supported.has(level));
  return levels.length ? levels : ["off"];
}

export function createCustomModelResolver() {
  const models = builtinProviders().flatMap((provider) => [...provider.getModels()]);
  const rank = (provider: string) => {
    const index = origins.indexOf(provider);
    return index < 0 ? origins.length : index;
  };
  models.sort(
    (a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider),
  );
  const byId = new Map<string, Model<Api>[]>();
  for (const model of models) {
    const matches = byId.get(model.id);
    if (matches) matches.push(model);
    else byId.set(model.id, [model]);
  }
  function match(id: string): Model<Api> | undefined {
    const exact = byId.get(id)?.[0];
    if (exact) return exact;
    const separator = id.indexOf("/");
    const prefix = id.slice(0, separator);
    if (separator < 1 || !origins.includes(prefix)) return undefined;
    const matches = byId.get(id.slice(separator + 1));
    return matches?.find((model) => model.provider === prefix) ?? matches?.[0];
  }
  function resolve(input: CustomModel) {
    const model = CustomModelSchema.parse(input);
    const inferred = match(model.id);
    const reasoning = model.reasoning ?? inferred?.reasoning ?? false;
    const thinkingLevelMap =
      reasoning && inferred?.reasoning ? inferred.thinkingLevelMap : undefined;
    const guessed = inferCustomModelLimits(model.id);
    const effective = {
      id: model.id,
      name: model.name ?? model.id,
      reasoning,
      input: model.input ?? inferred?.input ?? ["text"],
      contextWindow: model.contextWindow ?? inferred?.contextWindow ?? guessed.contextWindow,
      maxTokens: model.maxTokens ?? inferred?.maxTokens ?? guessed.maxTokens,
      thinkingLevelMap,
      // Negative SDK rates are its unknown-price sentinel; gateway billing is independent.
      cost: { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 },
    };
    const capabilities: CustomModelCapabilities = {
      reasoning: effective.reasoning,
      input: [...effective.input],
      contextWindow: effective.contextWindow,
      maxTokens: effective.maxTokens,
      thinkingLevels: modelThinkingLevels({
        ...effective,
        api: "openai-completions",
        provider: "pibot-custom",
        baseUrl: "http://127.0.0.1",
      }),
      // A catalog match names its source; a family estimate says so (推断 / inferred);
      // anything else keeps the "unrecognized, using defaults" note.
      ...(inferred
        ? { inferredFrom: { provider: inferred.provider, id: inferred.id } }
        : guessed.family !== "unknown"
          ? { inferredFrom: { provider: FAMILY_ESTIMATE, id: guessed.family } }
          : {}),
    };
    return { effective, resolved: { ...model, capabilities } satisfies ResolvedCustomModel };
  }
  return { resolve };
}
