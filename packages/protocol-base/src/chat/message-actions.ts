import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { MessageForwardSchema } from "./message-forward.ts";

export const MessageSelectionSchema = z.strictObject({
  conversationId: IdSchema,
  messageIds: z
    .array(IdSchema)
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const MessageDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bot"), botId: IdSchema }),
  z.strictObject({ kind: z.literal("group"), groupId: IdSchema, topicId: IdSchema }),
  z.strictObject({
    kind: z.literal("newGroup"),
    name: z.string().trim().min(1).max(200),
    botIds: z
      .array(IdSchema)
      .min(2)
      .max(6)
      .refine((ids) => new Set(ids).size === ids.length),
    coordinatorBotId: IdSchema,
  }),
]);
export const MessageTransferReceiptSchema = z
  .strictObject({
    requestId: IdSchema,
    state: z.enum(["pending", "done", "failed", "uncertain"]),
    botId: IdSchema.optional(),
    groupId: IdSchema.optional(),
    conversationId: IdSchema.optional(),
    userMessageId: IdSchema.optional(),
  })
  .refine(
    (value) =>
      !(value.botId && value.groupId) &&
      (value.state !== "done" ||
        (!!value.conversationId && !!value.userMessageId && !!(value.botId || value.groupId))),
  );
export const MessageActionMethods = {
  "messages.selection": {
    params: MessageSelectionSchema,
    result: z.strictObject({
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      count: z.number().int().min(1).max(50),
      preview: z.string().max(4000),
      previewForward: MessageForwardSchema.optional(),
      defaultBotIds: z.array(IdSchema).max(6),
      attachmentCount: z.number().int().min(0).max(10),
    }),
  },
  "messages.transfer": {
    params: MessageSelectionSchema.extend({
      requestId: IdSchema,
      selectionHash: z.string().regex(/^[a-f0-9]{64}$/),
      destination: MessageDestinationSchema,
      note: z.string().trim().max(4000).optional(),
      handoffSummary: z.string().trim().max(12000).optional(),
    }),
    result: MessageTransferReceiptSchema,
  },
  "messages.transferStatus": {
    params: z.strictObject({ requestId: IdSchema }),
    result: MessageTransferReceiptSchema.nullable(),
  },
  "messages.translate": {
    params: z.strictObject({
      conversationId: IdSchema,
      messageId: IdSchema,
      language: z.enum(["zh", "en"]),
    }),
    result: z.strictObject({ text: z.string().max(100000), language: z.enum(["zh", "en"]) }),
  },
  "messages.handoff": {
    params: MessageSelectionSchema.extend({ language: z.enum(["zh", "en"]) }),
    result: z.strictObject({
      text: z.string().max(12000),
      sourceCount: z.number().int().min(1).max(150),
      limited: z.boolean(),
    }),
  },
} as const;
export type MessageSelection = z.infer<typeof MessageSelectionSchema>;
export type MessageTransferReceipt = z.infer<typeof MessageTransferReceiptSchema>;
