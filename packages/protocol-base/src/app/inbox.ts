import { z } from "zod";
import { MemoryProposalSchema } from "../bots/memory.ts";
import { ConversationSchema, MessageSchema } from "../chat/entities.ts";
import { ComputerHandoffNoticeSchema } from "../chat/notices.ts";
import { PersonalTodoSchema } from "../chat/personal-todos.ts";
import { UserQuestionPauseSchema } from "../chat/user-question.ts";
import { BackgroundFailureSchema } from "../core/background-tasks.ts";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";
import { GroupPlanCardSchema } from "../groups/dynamic-plan.ts";
import { ApprovalSchema } from "../permissions/approvals.ts";
import { InboxOriginSchema } from "./inbox-origin.ts";

export { InboxOriginSchema } from "./inbox-origin.ts";

const page = PageSchema;
export const InboxCursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => {
    const p = v.split("|");
    if (
      p.length !== 3 ||
      !z.iso.datetime().safeParse(p[0]).success ||
      ![
        "group_plan",
        "group_plan_action",
        "approval",
        "memory",
        "provider",
        "connector_auth",
        "routine_approval",
        "routine_missed",
        "routine_proposal",
        "routine_trigger_error",
        "routines_paused_away",
        "computer_handoff",
        "personal_todo",
        "user_question",
        "background_task",
      ].includes(p[1] ?? "") ||
      !p[2]
    )
      return false;
    try {
      return !!decodeURIComponent(p[2]);
    } catch {
      return false;
    }
  }, "Invalid inbox cursor");
export const InboxKindSchema = z.enum([
  "group_plan",
  "group_plan_action",
  "approval",
  "memory",
  "provider",
  "connector_auth",
  "routine_approval",
  "routine_missed",
  "routine_proposal",
  "routine_trigger_error",
  "routines_paused_away",
  "computer_handoff",
  "personal_todo",
  "user_question",
  "background_task",
]);
export const InboxCountsSchema = z.strictObject({
  user_question: z.number().int().nonnegative().optional(),
  group_plan: z.number().int().nonnegative().optional(),
  group_plan_action: z.number().int().nonnegative().optional(),
  personal_todo: z.number().int().nonnegative().optional(),
  connector_auth: z.number().int().nonnegative().optional(),
  draft: z.number().int().nonnegative().optional(),
  routine_approval: z.number().int().nonnegative().optional(),
  routine_missed: z.number().int().nonnegative().optional(),
  routine_proposal: z.number().int().nonnegative().optional(),
  routine_trigger_error: z.number().int().nonnegative().optional(),
  routines_paused_away: z.number().int().nonnegative().optional(),
  computer_handoff: z.number().int().nonnegative().optional(),
  approval: z.number().int().nonnegative(),
  memory: z.number().int().nonnegative(),
  provider: z.number().int().nonnegative(),
  background_task: z.number().int().nonnegative().optional(),
});
export const InboxPageSchema = page.extend({
  before: InboxCursorSchema.optional(),
  kind: InboxKindSchema.optional(),
  draftsOnly: z.boolean().optional(),
  questionsOnly: z.boolean().optional(),
});
export type InboxPage = z.infer<typeof InboxPageSchema>;
export const GroupPlanInboxItemSchema = z.strictObject({
  kind: z.literal("group_plan"),
  cursor: InboxCursorSchema,
  origin: InboxOriginSchema.optional(),
  groupId: IdSchema,
  conversationId: IdSchema,
  messageId: IdSchema,
  card: GroupPlanCardSchema,
});
export const GroupPlanActionInboxItemSchema = z.strictObject({
  kind: z.literal("group_plan_action"),
  cursor: InboxCursorSchema,
  origin: InboxOriginSchema.optional(),
  groupId: IdSchema,
  message: MessageSchema,
});
export const UserQuestionInboxItemSchema = z.strictObject({
  kind: z.literal("user_question"),
  cursor: InboxCursorSchema,
  origin: InboxOriginSchema.optional(),
  message: MessageSchema,
  pause: UserQuestionPauseSchema,
});
const baseItemSchemas = [
  UserQuestionInboxItemSchema,
  GroupPlanActionInboxItemSchema,
  GroupPlanInboxItemSchema,
  z.strictObject({
    kind: z.literal("personal_todo"),
    cursor: InboxCursorSchema,
    origin: InboxOriginSchema.optional(),
    todo: PersonalTodoSchema,
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
    providerId: z.string().trim().min(1).max(200),
    state: z.literal("reauthRequired"),
  }),
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
] as const;

/** Inbox kinds owned by the kernel. Capability schemas are supplied by the composition root. */
export const KernelInboxItemSchema = z.discriminatedUnion("kind", baseItemSchemas);
/** Common envelope retained when a capability's concrete item type is not known to the kernel. */
export const CapabilityInboxItemSchema = z.looseObject({
  kind: z.string().trim().min(1).max(200),
  cursor: InboxCursorSchema,
  origin: InboxOriginSchema.optional(),
});
export const BaseInboxItemSchema = KernelInboxItemSchema;
export type InboxItemEnvelope =
  | z.output<typeof KernelInboxItemSchema>
  | (z.output<typeof CapabilityInboxItemSchema> & Record<string, unknown>);
export const KernelInboxMethods = {
  // The composition root replaces this result with its concrete discriminated union. The kernel
  // keeps only the envelope because capability kinds are registered at runtime.
  "inbox.list": { params: InboxPageSchema, result: z.array(CapabilityInboxItemSchema).max(200) },
} as const;
export const InboxCountMethods = {
  "inbox.counts": { params: z.undefined(), result: InboxCountsSchema },
  /**
   * Dismisses a "background task keeps failing" card by clearing its streak: it comes back only
   * if the task fails the threshold number of times again, so an ongoing fault is not hidden.
   */
  "inbox.dismissBackgroundTask": {
    params: BackgroundFailureSchema.pick({ task: true, subject: true, reasonCode: true }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;
export const InboxEvents = {
  "inbox.changed": z.strictObject({}),
} as const;
