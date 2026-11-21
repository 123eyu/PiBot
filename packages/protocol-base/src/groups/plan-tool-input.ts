import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { AcceptanceSchema, DeliverableSchema } from "../skills/contract.ts";
import {
  GROUP_PLAN_MAX_STEPS,
  GroupPlanDispositionSchema,
  GroupPlanObjectSchema,
  GroupPlanStepSchema,
} from "./dynamic-plan.ts";

const PlanAcceptanceSchema = GroupPlanStepSchema.shape.acceptance.element;

const toolDeliverables = z
  .array(DeliverableSchema.extend({ path: z.string().trim().min(1).max(4096).refine(plainText) }))
  .min(1)
  .max(10);
const toolAcceptance = z.array(PlanAcceptanceSchema).min(1).max(20);

/** Only method expansion may fill omitted contracts, before the unchanged strict D1 schema. */
function toolSteps<T extends z.ZodType>(acceptance: T) {
  const step = GroupPlanStepSchema.extend({ deliverables: toolDeliverables, acceptance });
  return z
    .array(
      z.union([
        step.omit({ method: true }),
        step.extend({
          method: GroupPlanStepSchema.shape.method.unwrap(),
          deliverables: toolDeliverables.optional(),
          acceptance: acceptance.optional(),
        }),
      ]),
    )
    .min(1)
    .max(GROUP_PLAN_MAX_STEPS);
}

/** Only D1 may turn a prefixed path into a checked relative deliverable. */
export const GroupPlanToolSchema = GroupPlanObjectSchema.extend({
  steps: z
    .array(GroupPlanStepSchema.extend({ deliverables: toolDeliverables }))
    .min(1)
    .max(GROUP_PLAN_MAX_STEPS),
});

/** Model input may inherit a method; delivery normalization requires its expanded contract. */
export const GroupPlanToolInputSchema = GroupPlanObjectSchema.extend({
  steps: toolSteps(toolAcceptance),
  disposition: GroupPlanDispositionSchema.optional(),
});

const acceptanceFields = AcceptanceSchema.shape;
const declaredAcceptance = z.union([
  z.strictObject({
    id: acceptanceFields.id,
    text: acceptanceFields.text,
    deliverable: acceptanceFields.deliverable,
    check: acceptanceFields.check.exclude(["manual", "minCitations", "tableColumns"]),
  }),
  z.strictObject({
    id: acceptanceFields.id,
    text: acceptanceFields.text.unwrap(),
    deliverable: acceptanceFields.deliverable,
    check: z.literal("manual"),
  }),
  z.strictObject({
    id: acceptanceFields.id,
    text: acceptanceFields.text,
    deliverable: acceptanceFields.deliverable,
    check: z.literal("minCitations"),
    min: acceptanceFields.min.unwrap(),
  }),
  z.strictObject({
    id: acceptanceFields.id,
    text: acceptanceFields.text,
    deliverable: acceptanceFields.deliverable,
    check: z.literal("tableColumns"),
    columns: acceptanceFields.columns.unwrap(),
  }),
]);

/** JSON Schema cannot express superRefine; expose its fixed check/field conditions explicitly. */
export const GroupPlanToolDeclarationSchema = GroupPlanObjectSchema.extend({
  steps: toolSteps(z.array(declaredAcceptance).min(1).max(20)),
  disposition: GroupPlanDispositionSchema.optional(),
});
