import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { AttachmentInputSchema, MAX_ATTACHMENTS } from "./attachments.ts";
import { MessageSchema } from "./entities.ts";

export const ChatAdditionModeSchema = z.enum(["steer", "followUp"]);
export const ChatAdditionSchema = z.strictObject({
  requestId: IdSchema,
  mode: ChatAdditionModeSchema,
  /** `unsent`: the run ended before taking it; the model never saw it, so it can go back. */
  state: z.enum(["queued", "received", "processed", "interrupted", "unsent"]),
});
export type ChatAddition = z.infer<typeof ChatAdditionSchema>;
export type ChatAdditionMode = z.infer<typeof ChatAdditionModeSchema>;

export function chatAddition(message: { usage: unknown }): ChatAddition | undefined {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || !("chatAddition" in usage)) return;
  const parsed = ChatAdditionSchema.safeParse(usage.chatAddition);
  return parsed.success ? parsed.data : undefined;
}

export function chatReplyTo(message: { usage: unknown }): string | undefined {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || !("chatReplyTo" in usage)) return;
  const parsed = IdSchema.safeParse(usage.chatReplyTo);
  return parsed.success ? parsed.data : undefined;
}

const target = { botId: IdSchema, topicId: IdSchema };
const receipt = MessageSchema.refine(
  (message) =>
    message.role === "user" &&
    message.runId !== null &&
    chatAddition(message)?.requestId === message.id,
);
export const ChatAdditionMethods = {
  "chat.append": {
    params: z
      .strictObject({
        ...target,
        runId: IdSchema,
        requestId: IdSchema,
        mode: ChatAdditionModeSchema,
        text: z.string().max(100_000),
        attachments: z.array(AttachmentInputSchema).max(MAX_ATTACHMENTS).optional(),
        attachmentIds: z.array(IdSchema).max(MAX_ATTACHMENTS).optional(),
      })
      .refine(
        (p) =>
          (p.attachments?.length ?? 0) + (p.attachmentIds?.length ?? 0) <= MAX_ATTACHMENTS &&
          (!!p.text.trim() || !!p.attachments?.length || !!p.attachmentIds?.length),
      ),
    result: receipt,
  },
  "groups.append": {
    params: z
      .strictObject({
        groupId: IdSchema,
        conversationId: IdSchema,
        botId: IdSchema,
        runId: IdSchema,
        requestId: IdSchema,
        mode: ChatAdditionModeSchema,
        targetBotId: IdSchema.optional(),
        text: z.string().max(100_000),
        attachments: z.array(AttachmentInputSchema).max(MAX_ATTACHMENTS).optional(),
        attachmentIds: z.array(IdSchema).max(MAX_ATTACHMENTS).optional(),
      })
      .refine(
        (p) =>
          (p.attachments?.length ?? 0) + (p.attachmentIds?.length ?? 0) <= MAX_ATTACHMENTS &&
          (!!p.text.trim() || !!p.attachments?.length || !!p.attachmentIds?.length),
      ),
    result: receipt,
  },
  "groups.appendStatus": {
    params: z.strictObject({
      groupId: IdSchema,
      conversationId: IdSchema,
      botId: IdSchema,
      requestId: IdSchema,
    }),
    result: z
      .strictObject({
        state: z.enum(["preparing", "absent", "accepted"]),
        message: receipt.nullable(),
      })
      .refine((result) => (result.state === "accepted") === (result.message !== null)),
  },
  /** Moves a not yet delivered addition between steer and follow-up. */
  "chat.appendMode": {
    params: z.strictObject({ ...target, requestId: IdSchema, mode: ChatAdditionModeSchema }),
    result: receipt,
  },
  /** The member is the one whose run holds the addition; the brain reads it from the run. */
  "groups.appendMode": {
    params: z.strictObject({
      groupId: IdSchema,
      conversationId: IdSchema,
      requestId: IdSchema,
      mode: ChatAdditionModeSchema,
    }),
    result: receipt,
  },
  "chat.appendStatus": {
    params: z.strictObject({ ...target, requestId: IdSchema }),
    result: z
      .strictObject({
        state: z.enum(["preparing", "absent", "accepted"]),
        message: receipt.nullable(),
      })
      .refine((result) => (result.state === "accepted") === (result.message !== null)),
  },
} as const;

export const ChatAdditionEvents = {
  "chat.message": z
    .strictObject({
      botId: IdSchema,
      conversationId: IdSchema,
      runId: IdSchema,
      messageId: IdSchema,
      message: MessageSchema,
    })
    .refine(
      (event) =>
        event.messageId === event.message.id &&
        event.runId === event.message.runId &&
        event.conversationId === event.message.conversationId &&
        (event.message.botId === undefined ||
          event.message.botId === null ||
          event.message.botId === event.botId),
    ),
} as const;
