import { AgentError } from "@pibot/agent";
import { checkedImage } from "@pibot/brain/kit";
import { type ImageContent, ImageContentSchema } from "@pibot/images-contract/full";

export function validatedImages(images: ImageContent[]) {
  try {
    if (!images.length || images.length > 5) throw new Error("Invalid image count");
    return images.map((image) => {
      const parsed = ImageContentSchema.parse(image);
      return { image: parsed, bytes: checkedImage(parsed.data, parsed.mimeType) };
    });
  } catch {
    throw new AgentError("provider_error");
  }
}

// Only numeric billing metadata can enter history. Provider bodies are not usage DTOs.
export function imageUsage(value: unknown): Record<string, number | Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const numeric = Object.fromEntries(
    [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cost",
      "inputCost",
      "outputCost",
    ].flatMap((key) => {
      const field = (value as Record<string, unknown>)[key];
      return typeof field === "number" && Number.isFinite(field) && field >= 0
        ? [[key, field]]
        : [];
    }),
  );
  const rawCost = (value as Record<string, unknown>).cost;
  if (rawCost && typeof rawCost === "object" && !Array.isArray(rawCost)) {
    const cost = Object.fromEntries(
      ["input", "output", "cacheRead", "cacheWrite", "total"].flatMap((key) => {
        const field = (rawCost as Record<string, unknown>)[key];
        return typeof field === "number" && Number.isFinite(field) && field >= 0
          ? [[key, field]]
          : [];
      }),
    );
    return Object.keys(cost).length ? { ...numeric, cost } : numeric;
  }
  return numeric;
}

/** Missing image token/price metadata remains unknown, including unpriced zero catalogue costs. */
export function observedImageUsage(
  value: unknown,
): { tokens?: number; costUsd?: number } | undefined {
  const fields = imageUsage(value);
  const input = fields.inputTokens ?? fields.input;
  const output = fields.outputTokens ?? fields.output;
  const tokens =
    typeof fields.totalTokens === "number"
      ? fields.totalTokens
      : typeof input === "number" && typeof output === "number"
        ? input +
          output +
          (typeof fields.cacheRead === "number" ? fields.cacheRead : 0) +
          (typeof fields.cacheWrite === "number" ? fields.cacheWrite : 0)
        : undefined;
  const cost = typeof fields.cost === "number" ? fields.cost : fields.cost?.total;
  const costUsd = typeof cost === "number" && cost > 0 ? cost : undefined;
  if (tokens === undefined && costUsd === undefined) return undefined;
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}
