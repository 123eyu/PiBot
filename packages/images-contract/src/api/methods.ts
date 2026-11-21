import { IdSchema, ImageOperationSchema } from "@pibot/protocol-base";
import { z } from "zod";
export const ImageArtifactMethods = {
  "images.reuse": {
    params: ImageOperationSchema.extend({ botId: IdSchema, conversationId: IdSchema }),
    result: z.strictObject({
      runId: IdSchema,
      assistantMessageId: IdSchema,
      conversationId: IdSchema,
    }),
  },
} as const;
