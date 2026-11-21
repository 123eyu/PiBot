import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { AttachmentSchema, MAX_REPLY_ATTACHMENTS } from "./attachments.ts";

/** A bounded display snapshot; the source ID never grants file or conversation access. */
export const MessageQuoteSchema = z.strictObject({
  messageId: IdSchema,
  botId: IdSchema.nullable(),
  role: z.enum(["user", "assistant", "error"]),
  author: z.string().max(200),
  content: z.string().max(2000),
  attachments: z.array(AttachmentSchema).max(MAX_REPLY_ATTACHMENTS),
});
export type MessageQuote = z.infer<typeof MessageQuoteSchema>;
export function messageQuote(message: { usage: unknown }): MessageQuote | undefined {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const result = MessageQuoteSchema.safeParse((usage as Record<string, unknown>).messageQuote);
  return result.success ? result.data : undefined;
}
