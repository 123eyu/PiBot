import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { defaultModelFor } from "@pibot/protocol-base";

/**
 * The ChatGPT plan's chat model ids (pi's ChatGPT-backend `openai-codex` catalog,
 * 2026-11-15) and the one a moved choice falls back to. Synchronous and network-free, so a
 * startup data step can use it before any runtime is built.
 */
export function chatGPTPlanModels(): { ids: string[]; defaultId?: string } {
  const models =
    builtinProviders()
      .find((provider) => provider.id === "openai-codex")
      ?.getModels() ?? [];
  const price = (value: number) => (value < 0 ? null : value);
  const fallback = defaultModelFor(
    models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      input: [...model.input],
      reasoning: model.reasoning,
      cost: {
        input: price(model.cost.input),
        output: price(model.cost.output),
        cacheRead: price(model.cost.cacheRead),
        cacheWrite: price(model.cost.cacheWrite),
      },
    })),
  );
  return { ids: models.map((model) => model.id), ...(fallback ? { defaultId: fallback.id } : {}) };
}
