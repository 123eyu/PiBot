import { z } from "zod";

// One verified historical spelling of the same OpenRouter model; never normalize arbitrary slugs.
export function canonicalImageModelId(provider: string, id: string) {
  return provider === "openrouter" && id === "bytedance-seed/seedream-5.0-pro"
    ? "bytedance-seed/seedream-5-0-pro"
    : id;
}
export const BotCategorySchema = z.enum(["chat", "image"]);
export const ImageModeSchema = z.enum(["text-to-image", "image-to-image"]);
export const ImageApiSchema = z.enum([
  "openai-images",
  "google-images",
  "openrouter-images",
  "codex-images",
]);
export const CustomImageModelSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  modes: z
    .array(ImageModeSchema)
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length),
});
export const ImageModelInfoSchema = z.strictObject({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  modes: z.array(ImageModeSchema).min(1).max(2),
  output: z
    .array(z.enum(["image", "text"]))
    .min(1)
    .max(2)
    .refine((value) => value.includes("image")),
  configured: z.boolean(),
  source: z.enum(["sdk", "official", "custom"]),
  experimental: z.boolean().optional(),
  // The selected service host is public metadata, never a credential-bearing URL.
  recipient: z.string().min(1).max(253),
});
export const ImageModelPageSchema = z.strictObject({
  selected: z
    .strictObject({ provider: z.string().min(1).max(200), id: z.string().min(1).max(200) })
    .optional(),
  availableOnly: z.boolean().optional(),
  mode: ImageModeSchema.optional(),
  before: z.string().min(1).max(1000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type BotCategory = z.infer<typeof BotCategorySchema>;
export type ImageMode = z.infer<typeof ImageModeSchema>;
export type ImageApi = z.infer<typeof ImageApiSchema>;
export type CustomImageModel = z.infer<typeof CustomImageModelSchema>;
export type ImageModelInfo = z.infer<typeof ImageModelInfoSchema>;
