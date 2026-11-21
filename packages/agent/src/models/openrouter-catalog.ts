import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { z } from "zod";
import { inferCustomModelLimits } from "./custom-models.ts";

const price = z.string().max(64).optional();
const tokens = z.number().int().positive().max(100_000_000);
const entry = z.object({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(500),
  context_length: tokens,
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  top_provider: z.object({ max_completion_tokens: tokens.nullable().optional() }).optional(),
  supported_parameters: z.array(z.string()).optional(),
  pricing: z
    .object({ prompt: price, completion: price, input_cache_read: price, input_cache_write: price })
    .optional(),
});
const cost = z.union([z.literal(-1), z.number().finite().nonnegative()]);
export const CatalogModelSchema = z.strictObject({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(500),
  contextWindow: tokens,
  maxTokens: tokens,
  reasoning: z.boolean(),
  input: z
    .array(z.enum(["text", "image"]))
    .min(1)
    .max(2),
  cost: z.strictObject({ input: cost, output: cost, cacheRead: cost, cacheWrite: cost }),
});
export const CatalogSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    updatedAt: z.iso.datetime(),
    models: z.array(CatalogModelSchema).min(1).max(10000),
    imageModels: z.array(CatalogModelSchema).max(10000).default([]),
  })
  .refine(
    (snapshot) =>
      new Set(snapshot.models.map((model) => model.id)).size === snapshot.models.length &&
      snapshot.models.every(
        (model) => model.maxTokens <= model.contextWindow && model.input.includes("text"),
      ),
  );
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

function rate(value?: string) {
  if (value === undefined || value.trim() === "") return -1;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : -1;
}

export async function fetchOpenRouterCatalog(signal: AbortSignal): Promise<CatalogSnapshot> {
  // This is public metadata. Never attach a user's API key or accept a server-supplied endpoint.
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Model catalog unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model catalog missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("Model catalog too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const body = z
    .object({ data: z.array(z.unknown()).min(1).max(10000) })
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const models: CatalogSnapshot["models"] = [];
  const ids = new Set<string>();
  for (const raw of body.data) {
    const { architecture } = entry.pick({ architecture: true }).parse(raw);
    // Exclude generators before validating chat metadata; a malformed chat entry rejects the
    // refresh rather than silently replacing a complete cached catalog with a partial list.
    if (
      !architecture.input_modalities.includes("text") ||
      !architecture.output_modalities.includes("text") ||
      architecture.output_modalities.includes("image")
    )
      continue;
    const model = entry.parse(raw);
    if (ids.has(model.id)) throw new Error("Duplicate catalog model");
    ids.add(model.id);
    const inferred = inferCustomModelLimits(model.id);
    models.push({
      id: model.id,
      name: model.name,
      contextWindow: model.context_length,
      maxTokens: Math.min(
        model.context_length,
        model.top_provider?.max_completion_tokens ?? inferred.maxTokens,
      ),
      input: model.architecture.input_modalities.includes("image") ? ["text", "image"] : ["text"],
      reasoning: model.supported_parameters?.includes("reasoning") ?? false,
      cost: {
        input: rate(model.pricing?.prompt),
        output: rate(model.pricing?.completion),
        cacheRead: rate(model.pricing?.input_cache_read),
        cacheWrite: rate(model.pricing?.input_cache_write),
      },
    });
  }
  signal.throwIfAborted();
  // Image generation has a separate public catalog. Keep it independent from the chat list:
  // OpenRouter adds/removes image providers more often and the chat endpoint intentionally
  // excludes image-only entries. A stale or temporarily unavailable image endpoint must not
  // discard an otherwise valid chat catalog.
  const imageModels = await fetchOpenRouterImageCatalog(signal);
  return CatalogSnapshotSchema.parse({
    version: 1,
    updatedAt: new Date().toISOString(),
    models,
    imageModels,
  });
}

async function fetchOpenRouterImageCatalog(
  signal: AbortSignal,
): Promise<CatalogSnapshot["imageModels"]> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/images/models", {
      signal,
      redirect: "error",
    });
    if (!response.ok) return [];
    const body = z.object({ data: z.array(z.unknown()).max(10000) }).parse(await response.json());
    const result: CatalogSnapshot["imageModels"] = [];
    const ids = new Set<string>();
    for (const raw of body.data) {
      const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const id = typeof value.id === "string" ? value.id : "";
      const name = typeof value.name === "string" ? value.name : id;
      const architecture =
        value.architecture && typeof value.architecture === "object"
          ? (value.architecture as Record<string, unknown>)
          : {};
      const inputModalities = Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities.filter((item): item is string => typeof item === "string")
        : ["text"];
      if (!id || !name || ids.has(id) || !inputModalities.includes("text")) continue;
      const contextLength = Number(value.context_length ?? 128_000);
      if (!Number.isSafeInteger(contextLength) || contextLength < 1) continue;
      ids.add(id);
      result.push({
        id,
        name,
        contextWindow: contextLength,
        maxTokens: contextLength,
        reasoning: false,
        input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
        cost: { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 },
      });
    }
    return result;
  } catch {
    return [];
  }
}

export function withOpenRouterCatalog(provider: Provider, snapshot?: CatalogSnapshot): Provider {
  if (provider.id !== "openrouter" || !snapshot) return provider;
  const known = new Map(provider.getModels().map((model) => [model.id, model]));
  const models: Model<Api>[] = snapshot.models.map((model) => ({
    // Keep SDK-specific compatibility and thinking mappings for already known model IDs.
    ...known.get(model.id),
    ...model,
    provider: "openrouter",
    api: known.get(model.id)?.api ?? "openai-completions",
    baseUrl: known.get(model.id)?.baseUrl ?? "https://openrouter.ai/api/v1",
  }));
  const imageModels = (snapshot.imageModels ?? []).map((model) => ({
    ...model,
    type: "image" as const,
    provider: "openrouter",
    api: "openrouter-images" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    output: ["image"] as ["image"],
  }));
  const other =
    provider
      .getAllModels?.()
      .filter((model) => model.type && model.type !== "chat" && model.type !== "image") ?? [];
  return {
    ...provider,
    getModels: () => models,
    getAllModels: () => [...models, ...imageModels, ...other],
  };
}
