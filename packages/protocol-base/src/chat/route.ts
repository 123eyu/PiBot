import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

// Routes are optional only on older events; newer producers always include the real speaking Bot.
export const ChatRouteFields = {
  botId: IdSchema.optional(),
  conversationId: IdSchema.optional(),
  groupId: IdSchema.optional(),
  threadId: IdSchema.optional(),
};
export const ChatTargetSchema = z.union([
  z
    .object({
      botId: IdSchema,
      topicId: IdSchema.optional(),
      groupId: z.never().optional(),
      threadId: z.never().optional(),
    })
    .passthrough(),
  z
    .object({
      groupId: IdSchema,
      threadId: IdSchema.optional(),
      botId: z.never().optional(),
      topicId: IdSchema.optional(),
    })
    .passthrough(),
]);
