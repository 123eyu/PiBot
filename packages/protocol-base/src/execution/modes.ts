import { z } from "zod";
import { UserQuestionReplySchema, UserQuestionSchema } from "../chat/user-question.ts";
import { IdSchema } from "../core/ids.ts";

export const ExecutionModeSchema = z.enum(["execute", "plan"]);
export const ExecutionLimitsSchema = z.strictObject({
  activeSeconds: z.number().int().min(30).max(86_400),
  toolCalls: z.number().int().min(1).max(10_000),
  modelRequests: z.number().int().min(1).max(1_000),
  childTasks: z.number().int().min(0).max(100),
  childConcurrency: z.number().int().min(1).max(8),
  childDepth: z.number().int().min(0).max(4),
  tokens: z.number().int().min(1_000).max(100_000_000),
  /** Unknown provider prices remain unknown, rather than being counted as zero. */
  costUsd: z.number().positive().max(10_000).nullable(),
});
export const DEFAULT_EXECUTION_LIMITS: z.infer<typeof ExecutionLimitsSchema> = {
  activeSeconds: 7_200,
  toolCalls: 1_000,
  modelRequests: 256,
  childTasks: 32,
  childConcurrency: 4,
  childDepth: 3,
  tokens: 10_000_000,
  costUsd: null,
};
export const ExecutionScopeSchema = z.strictObject({ botId: IdSchema, conversationId: IdSchema });
export const ExecutionSettingsSchema = ExecutionScopeSchema.extend({
  mode: ExecutionModeSchema,
  limits: ExecutionLimitsSchema,
  version: z.number().int().nonnegative().safe(),
  updatedAt: z.iso.datetime().nullable(),
});

export const TodoItemSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  title: z.string().trim().min(1).max(500),
  status: z.enum(["pending", "in_progress", "done", "cancelled"]),
});
const TodoItemsSchema = z
  .array(TodoItemSchema)
  .max(50)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: "Duplicate todo item id",
  });
export const TodoSourceSchema = z.strictObject({
  runId: IdSchema,
  messageId: IdSchema,
  toolCallId: z.string().min(1),
});
export const TodoPlanSchema = ExecutionScopeSchema.extend({
  goal: z.string().trim().max(2_000),
  items: TodoItemsSchema,
  /** Server-observed first tool update; absent/null means the original reply is unknown. */
  source: TodoSourceSchema.nullable().optional(),
  version: z.number().int().nonnegative().safe(),
  updatedAt: z.iso.datetime().nullable(),
});
/** Full snapshots keep retries/version conflicts explicit; callers may never rewrite another scope. */
export const TodoUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative().safe(),
  goal: z.string().trim().max(2_000),
  items: TodoItemsSchema,
});
// awaiting_reply: the Bot asked something open (a quiz answer, material, a prose confirmation) and
// waits for the next message; a choice between options is still ask_user (maintainers 2026-11-05: 小知
// looped on todo_pause because "waiting for the user" had no valid reason).
const pauseReason = z.enum([
  "blocked",
  "needs_user",
  "review",
  "checkpoint",
  "waiting_tasks",
  "awaiting_reply",
]);
const pauseSummary = z.string().trim().min(1).max(500);

// Keep questions out of the model's pause contract: providers/models may fill every optional
// field. Decisions have their own ask_user tool; persisted legacy needs_user calls still parse.
export const TodoPauseToolDeclarationSchema = z.strictObject({
  reason: pauseReason.exclude(["needs_user"]),
  summary: pauseSummary,
});
export const TodoPauseSchema = z
  .strictObject({
    reason: pauseReason,
    summary: pauseSummary,
    question: UserQuestionSchema.optional(),
  })
  .refine((pause) => !pause.question || pause.reason === "needs_user", {
    path: ["question"],
    message: "todo_pause_question_reason",
  });

export const ExecutionMethods = {
  "execution.question.dismiss": {
    params: z.strictObject({ messageId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "execution.question.answer": {
    timeoutMs: 95_000,
    params: z.strictObject({ messageId: IdSchema, reply: UserQuestionReplySchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "execution.get": { params: ExecutionScopeSchema, result: ExecutionSettingsSchema },
  "execution.set": {
    params: ExecutionScopeSchema.extend({
      expectedVersion: z.number().int().nonnegative().safe(),
      mode: ExecutionModeSchema,
      limits: ExecutionLimitsSchema.optional(),
    }),
    result: ExecutionSettingsSchema,
  },
  "execution.todo.get": { params: ExecutionScopeSchema, result: TodoPlanSchema },
  "execution.todo.set": {
    params: ExecutionScopeSchema.extend(TodoUpdateSchema.shape),
    result: TodoPlanSchema,
  },
} as const;
export const ExecutionEvents = {
  "execution.question.answered": z.strictObject({
    botId: IdSchema,
    conversationIds: z.array(IdSchema).min(1).max(2),
  }),
  "execution.changed": ExecutionSettingsSchema,
  "execution.todo.changed": TodoPlanSchema,
} as const;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;
export type ExecutionScope = z.infer<typeof ExecutionScopeSchema>;
export type ExecutionSettings = z.infer<typeof ExecutionSettingsSchema>;
export type TodoPlan = z.infer<typeof TodoPlanSchema>;
/** Program-observed follow-through exhaustion; the title is display data, never authority. */
export const ExecutionStallSchema = z.strictObject({
  reason: z.enum(["no_progress", "round_limit"]),
  index: z.number().int().min(1).max(50),
  title: z.string().max(250),
});
export type ExecutionStall = z.infer<typeof ExecutionStallSchema>;
export type TodoUpdate = z.infer<typeof TodoUpdateSchema>;
