import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { AbsolutePathSchema, WorkspaceSnapshotSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import { DeliveryItemSchema } from "../execution/run-receipt.ts";
import {
  AcceptanceSchema,
  DeliverablePathSchema,
  DeliverableSchema,
  WorkflowInputValuesSchema,
  WorkflowParamValuesSchema,
} from "../skills/contract.ts";

/**
 * Structured hand-off: an `assign_task` that says what must come back
 * (`expectedOutput`) and when it is done (`doneWhen`). The program judges what it can (files
 * present, a workflow's acceptance items) when the member finishes, sends an unmet result back
 * once, then stops for the user. Hand-offs count against their own cap, not the automatic rounds
 * that bound free discussion.
 */

/** Per user message (group cycle): 4 stages × (assign + sign-off wake) × one send-back each. */
export const HANDOFF_LIMIT = 16;
export const HANDOFF_FILES = 5;
export const HANDOFF_ACCEPTANCE = 10;
export const HANDOFF_ARTIFACTS = 10;
const HANDOFF_ITEMS = 30;
const text = (max: number) => z.string().trim().min(1).max(max).refine(plainText);

/** `assign_task` arguments (tool boundary). */
export const HandoffWorkflowArgsSchema = z.strictObject({
  /** The member's contract skill (display name, folder name or id) it runs as a workflow. */
  skill: text(200),
  /** Folder / file paths or text by input name; unnamed inputs inherit the coordinator's run. */
  inputs: WorkflowInputValuesSchema.optional(),
  params: WorkflowParamValuesSchema.optional(),
});
export const HandoffExpectedOutputSchema = z.strictObject({
  /** Files the member must leave behind, relative to the workflow folder (or primary folder). */
  files: z.array(DeliverablePathSchema).min(1).max(HANDOFF_FILES).optional(),
  /** Who uses it and in what form; read by the member, never judged by the program. */
  form: text(500).optional(),
});
export const HandoffDoneWhenSchema = z.strictObject({
  /** Acceptance ids of `workflow`'s contract; omitted = every automatic item of it. */
  acceptance: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/))
    .min(1)
    .max(HANDOFF_ACCEPTANCE)
    .optional(),
  /** A condition only a model can judge: left to the coordinator at sign-off. */
  condition: text(1000).optional(),
});

/** What the program stored at assignment (trusted, built from the member's contract). */
export const HandoffSpecSchema = z.strictObject({
  /** Program-frozen context only; never a field in assign_task's model arguments. */
  deliveryLocation: z
    .strictObject({
      workspaceRoot: AbsolutePathSchema.max(4096),
      location: WorkspaceSnapshotSchema.shape.location,
      workspaceRevision: z.number().int().nonnegative().optional(),
      originals: z
        .array(
          z.strictObject({
            path: DeliverablePathSchema,
            original: z.string().min(1).max(4096),
          }),
        )
        .max(20),
    })
    .optional(),
  /** Reference only; durable DAG state remains in group_workflow_steps. */
  workflowStep: z
    .strictObject({
      workflowRunId: IdSchema,
      stepId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    })
    .optional(),
  workflow: z
    .strictObject({
      skillId: IdSchema,
      name: z.string().min(1).max(200),
      version: z.number().int().positive().nullable(),
    })
    .nullable(),
  files: z.array(DeliverablePathSchema).max(10),
  form: z.string().max(500).nullable(),
  condition: z.string().max(1000).nullable(),
  /** Only the contract parts the selected acceptance items use. */
  deliverables: z.array(DeliverableSchema).max(20),
  acceptance: z.array(AcceptanceSchema).max(20),
});
/**
 * The coordinator's workflow run the hand-off belongs to, carried to its sign-off run so the
 * coordinator keeps the skill body, folder and inputs (and its own delivery check) across stages.
 */
export const HandoffPipelineSchema = z.strictObject({
  skillId: IdSchema,
  name: z.string().min(1).max(200),
  folder: z.string().min(1).max(4096),
  params: z
    .array(z.strictObject({ name: z.string().max(40), value: z.string().max(1000) }))
    .max(20),
  inputs: z
    .array(
      z.strictObject({
        name: z.string().max(40),
        kind: z.enum(["folder", "file", "text"]),
        value: z.string().max(4000),
      }),
    )
    .max(12),
  previous: z
    .strictObject({
      folder: z.string().min(1).max(4096),
      files: z.array(z.string().max(500)).max(20),
    })
    .optional(),
});
/** The program's check when the member finished: same item shape as workflow delivery checks. */
export const HandoffResultSchema = z.strictObject({
  items: z.array(DeliveryItemSchema).max(HANDOFF_ITEMS),
  /** Files the member's finishing run wrote (paths only). */
  artifacts: z.array(z.string().min(1).max(500)).max(HANDOFF_ARTIFACTS),
  durationMs: z.number().int().nonnegative().safe(),
  /** The user settled the task by hand: nothing is judged or sent back. */
  userResolved: z.boolean().optional(),
  /** The check could not run (timeout, folder unavailable); left to the coordinator. */
  unavailable: z.boolean().optional(),
});
export const HandoffStateSchema = z.enum(["pending", "met", "returned", "unmet"]);

/** Task-card facts; checked wrong_location items may include expected / actual absolute paths. */
export const GroupTaskHandoffSchema = z.strictObject({
  workflow: z.string().max(200).nullable(),
  files: z.array(z.string().max(200)).max(10),
  form: z.string().max(500).nullable(),
  acceptance: z
    .array(z.strictObject({ id: z.string().max(40), text: z.string().max(300).nullable() }))
    .max(20),
  condition: z.string().max(1000).nullable(),
  state: HandoffStateSchema,
  userConfirmed: z.boolean().optional(),
  /** This task is the one send-back of that task. */
  returnOf: IdSchema.nullable(),
  items: z.array(DeliveryItemSchema).max(HANDOFF_ITEMS),
  artifacts: z.array(z.string().max(500)).max(HANDOFF_ARTIFACTS),
});

export type HandoffWorkflowArgs = z.infer<typeof HandoffWorkflowArgsSchema>;
export type HandoffExpectedOutput = z.infer<typeof HandoffExpectedOutputSchema>;
export type HandoffDoneWhen = z.infer<typeof HandoffDoneWhenSchema>;
export type HandoffSpec = z.infer<typeof HandoffSpecSchema>;
export type HandoffPipeline = z.infer<typeof HandoffPipelineSchema>;
export type HandoffResult = z.infer<typeof HandoffResultSchema>;
export type HandoffState = z.infer<typeof HandoffStateSchema>;
export type GroupTaskHandoff = z.infer<typeof GroupTaskHandoffSchema>;
