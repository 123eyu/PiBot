import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { AcceptanceCheckSchema, DeliverableSchema } from "../skills/contract.ts";

const key = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const text = (max: number) => z.string().min(1).max(max).refine(plainText);
const names = z.array(text(80)).min(1).max(20);
const minimum = z.number().int().min(1).max(200);
/** Values from the two effective plans, never an explanation authored by the model. */
const detail = z.discriminatedUnion("change", [
  z.strictObject({ change: z.literal("output_name"), before: text(200), after: text(200) }),
  z.strictObject({ change: z.literal("output_path"), before: text(200), after: text(200) }),
  z.strictObject({ change: z.literal("output_id"), before: key, after: key }),
  z.strictObject({ change: z.literal("check_id"), before: key, after: key }),
  z.strictObject({ change: z.literal("method_removed"), method: text(80) }),
  z.strictObject({ change: z.literal("method_changed"), before: text(80), after: text(80) }),
  z.strictObject({ change: z.literal("check_removed"), check: AcceptanceCheckSchema }),
  z.strictObject({
    change: z.literal("check_changed"),
    before: AcceptanceCheckSchema,
    after: AcceptanceCheckSchema,
  }),
  z.strictObject({ change: z.literal("minimum"), before: minimum, after: minimum }),
  z.strictObject({ change: z.literal("columns"), removed: names }),
  z.strictObject({ change: z.literal("sections"), removed: names }),
  z.strictObject({ change: z.literal("output_removed"), path: text(200) }),
  z.strictObject({
    change: z.literal("output_kind"),
    before: DeliverableSchema.shape.kind,
    after: DeliverableSchema.shape.kind,
  }),
  z.strictObject({ change: z.literal("target"), before: key.optional(), after: key.optional() }),
  z.strictObject({ change: z.literal("manual") }),
]);
export const PlanRelaxationSchema = z.strictObject({
  stepId: key,
  targetId: key,
  kind: z.enum(["method", "check", "output"]),
  check: AcceptanceCheckSchema.optional(),
  stepTitle: text(200).optional(),
  // Historical cards keep their generic facts; concrete old values cannot be reconstructed.
  detail: detail.optional(),
});
export const PlanRelaxationsSchema = z.array(PlanRelaxationSchema).max(1620);
/** At most two replans, with both rounds retained rather than silently truncated. */
export const PlanRelaxationHistorySchema = z.array(PlanRelaxationSchema).max(3240);
export type PlanRelaxation = z.infer<typeof PlanRelaxationSchema>;

/** Renaming preserves requirements; old records without details retain their conservative meaning. */
export function hasAcceptanceRelaxation(changes: readonly PlanRelaxation[]): boolean {
  return changes.some(
    (item) =>
      !item.detail ||
      !["output_name", "output_path", "output_id", "check_id"].includes(item.detail.change),
  );
}
