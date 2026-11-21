import {
  ApprovalSchema,
  BackgroundFailureSchema,
  ComputerHandoffNoticeSchema,
  ConversationSchema,
  GroupPlanActionInboxItemSchema,
  GroupPlanInboxItemSchema,
  IdSchema,
  InboxCursorSchema,
  InboxOriginSchema,
  InboxPageSchema,
  MemoryProposalSchema,
  PersonalTodoSchema,
  UserQuestionInboxItemSchema,
} from "@pibot/protocol-base";
import {
  RoutineProposalSchema,
  RoutineRunViewSchema,
  RoutineSchema,
} from "@pibot/routines-contract";
import { z } from "zod";

const name = z.string().trim().min(1).max(200);
const time = z.iso.datetime();

/**
 * The inbox lists items from several capabilities (approvals, personal todos, memory proposals,
 * routines, computer handoffs). It is composed here, at the aggregation layer, so no kernel schema
 * has to import a capability's contract.
 */
const inboxItemSchema = z.discriminatedUnion("kind", [
  UserQuestionInboxItemSchema,
  GroupPlanInboxItemSchema,
  GroupPlanActionInboxItemSchema,
  z.strictObject({
    kind: z.literal("personal_todo"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    todo: PersonalTodoSchema,
  }),
  z.strictObject({
    kind: z.literal("connector_auth"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    connectorId: IdSchema,
    name: z.string().max(4096),
    reason: z.string().max(64).nullable(),
  }),
  z.strictObject({
    kind: z.literal("routine_approval"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    approval: ApprovalSchema,
    conversationId: IdSchema,
    conversationKind: ConversationSchema.shape.kind,
  }),
  z.strictObject({
    kind: z.literal("routine_trigger_error"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    routine: RoutineSchema,
  }),
  z.strictObject({
    kind: z.literal("routine_missed"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    run: RoutineRunViewSchema,
  }),
  z.strictObject({
    kind: z.literal("routine_proposal"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    proposal: RoutineProposalSchema,
    conversationId: IdSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("routines_paused_away"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    count: z.number().int().positive(),
    at: time,
  }),
  z.strictObject({
    kind: z.literal("approval"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    approval: ApprovalSchema,
    conversationId: IdSchema,
    conversationKind: ConversationSchema.shape.kind,
  }),
  z.strictObject({
    kind: z.literal("memory"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    proposal: MemoryProposalSchema,
    conversationId: IdSchema.nullable(),
    conversationKind: ConversationSchema.shape.kind.nullable(),
  }),
  z.strictObject({
    kind: z.literal("provider"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    providerId: name,
    state: z.literal("reauthRequired"),
  }),
  // "需要你操作": the same card as in the chat, answered from either place.
  z.strictObject({
    kind: z.literal("computer_handoff"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    notice: ComputerHandoffNoticeSchema,
    conversationKind: ConversationSchema.shape.kind,
    conversationTitle: z.string().max(200).nullable(),
  }),
  z.strictObject({
    kind: z.literal("background_task"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    health: BackgroundFailureSchema,
  }),
]);

export type InboxItem = z.infer<typeof inboxItemSchema>;
// Preserve the named DTO boundary instead of serializing every nested plan schema in Methods.
export const InboxItemSchema: z.ZodType<InboxItem> = inboxItemSchema;

export const InboxMethods = {
  "inbox.list": { params: InboxPageSchema, result: z.array(InboxItemSchema).max(200) },
} as const;
