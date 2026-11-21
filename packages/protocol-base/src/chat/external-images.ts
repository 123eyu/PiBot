import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { ImageContentSchema } from "./attachments.ts";

export const ExternalImageTargetSchema = z.strictObject({
  botId: IdSchema,
  messageId: IdSchema,
  url: z
    .string()
    .min(1)
    .max(32768)
    .refine((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
});
export const ExternalImageResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("loaded"), image: ImageContentSchema }),
  z.strictObject({
    status: z.enum(["network", "not_image", "too_large", "denied", "unsupported", "cancelled"]),
  }),
]);
export const ExternalImageMethods = {
  "chat.externalImageStatus": {
    params: ExternalImageTargetSchema,
    result: z.strictObject({ allowed: z.boolean() }),
  },
  "chat.loadExternalImage": {
    params: ExternalImageTargetSchema.extend({ requestId: IdSchema, confirmed: z.literal(true) }),
    result: ExternalImageResultSchema,
  },
  "chat.cancelExternalImage": {
    params: z.strictObject({ requestId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;
