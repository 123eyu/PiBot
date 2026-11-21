import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

/** Program-published delivery conclusion; independent of save-as-template eligibility. */
export const GroupPlanConclusionSchema = z.strictObject({
  workflowRunId: IdSchema,
  cycleId: IdSchema,
  outcome: z.enum(["completed", "incomplete"]),
});

const groupId = { groupId: IdSchema };
const topic = { ...groupId, topicId: IdSchema };
const selection = z.strictObject({ primary: IdSchema, readonly: z.array(IdSchema).max(20) });
export const AcpGroupRunReceiptSchema = z.strictObject({
  ...topic,
  runId: IdSchema,
  assistantMessageId: IdSchema,
  cycleId: IdSchema,
  budgetRootRunId: IdSchema,
  runIds: z.array(IdSchema).min(1).max(512),
});
export const AcpGroupSnapshotSchema = AcpGroupRunReceiptSchema.extend({
  state: z.enum([
    "running",
    "waiting_plan",
    "waiting_input",
    "paused",
    "limited",
    "failed",
    "cancelled",
    "completed",
  ]),
  activeRunIds: z.array(IdSchema).max(512),
  conversationIds: z.array(IdSchema).max(512),
  taskIds: z.array(IdSchema).max(512),
  workflowRunIds: z.array(IdSchema).max(128),
  complete: z.boolean(),
  terminal: z.boolean(),
  drained: z.boolean(),
  failureCode: z.enum(["group_acp_failed", "group_acp_stale", "group_acp_cancelled"]).optional(),
  runs: z
    .array(
      z.strictObject({
        runId: IdSchema,
        botId: IdSchema,
        conversationId: IdSchema,
        status: z.string().max(40),
      }),
    )
    .max(512),
});
const metadata = z.strictObject({
  id: IdSchema,
  name: z.string().max(200),
  coordinatorBotId: IdSchema,
  memberBotIds: z.array(IdSchema).min(1).max(100),
  archivedAt: z.string().nullable().optional(),
});
export const AcpGroupMethods = {
  "groups.acp.list": { params: z.strictObject({}), result: z.array(metadata).max(200) },
  "groups.acp.get": { params: z.strictObject(groupId), result: metadata },
  "groups.acp.topics.create": {
    params: z.strictObject({ ...groupId, selection, yolo: z.boolean().optional() }),
    result: z.strictObject({ topicId: IdSchema }),
  },
  "groups.acp.topics.attach": {
    params: z.strictObject({ ...topic, cwd: z.string().min(1).max(32768) }),
    result: z.strictObject({ topicId: IdSchema }),
  },
  "groups.acp.topics.rebind": { params: z.strictObject({ ...topic, selection }), result: z.null() },
  "groups.acp.topics.archive": { params: z.strictObject(topic), result: z.null() },
  "groups.acp.send": {
    params: z.strictObject({ ...topic, text: z.string().trim().min(1).max(100000) }),
    result: AcpGroupRunReceiptSchema,
  },
  "groups.acp.snapshot": { params: AcpGroupRunReceiptSchema, result: AcpGroupSnapshotSchema },
  "groups.acp.cancel": { params: AcpGroupRunReceiptSchema, result: AcpGroupSnapshotSchema },
} as const;
export type AcpGroupRunReceipt = z.infer<typeof AcpGroupRunReceiptSchema>;
export type AcpGroupSnapshot = z.infer<typeof AcpGroupSnapshotSchema>;
