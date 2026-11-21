import { z } from "zod";
import { ConversationSchema } from "../chat/entities.ts";
import { IdSchema } from "../core/ids.ts";

export const InboxOriginSchema = z.strictObject({
  botId: IdSchema.nullable(),
  botName: z.string().max(200).nullable(),
  groupId: IdSchema.nullable(),
  groupName: z.string().max(200).nullable(),
  conversationId: IdSchema.nullable(),
  conversationKind: ConversationSchema.shape.kind.nullable(),
  conversationTitle: z.string().max(200).nullable(),
  messageId: IdSchema.nullable(),
});
