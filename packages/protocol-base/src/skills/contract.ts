import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { IdSchema } from "../core/ids.ts";
import { CategorySchema } from "../permissions/settings.ts";
import { ThinkingLevelSchema } from "../providers/providers.ts";

/**
 * Work contract (`metadata.pibot-contract` in SKILL.md, a JSON string): the machine-readable
 * half of a workflow skill. The program enforces it (pre-checks before the model, delivery checks
 * after, budget, model tier); the model only sees the skill body and a few hard rules.
 */
const RESERVED = ["__proto__", "constructor", "prototype"];
const line = (max: number) => z.string().trim().min(1).max(max).refine(plainText);
const key = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/)
  .refine((v) => !RESERVED.includes(v));
/** Input names are form labels and keys of `inputs` in a run request. */
export const WorkflowInputNameSchema = line(40).refine((v) => !RESERVED.includes(v));
/**
 * A deliverable inside this run's artifact folder, "/"-separated and relative to it. Anything that
 * could leave the folder (absolute, drive letters, "..", empty names) is rejected.
 */
export const DeliverablePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (p) =>
      plainText(p) &&
      !/[<>:"|?*\\]/.test(p) &&
      !p.startsWith("/") &&
      p.split("/").every((s) => s.trim() !== "" && s !== "." && s !== ".." && !/[. ]$/.test(s)),
    "Relative path inside the artifact folder required",
  );
export const WorkflowInputSchema = z.strictObject({
  name: WorkflowInputNameSchema,
  /** `previous` is last period's artifact folder, filled in by the program. */
  kind: z.enum(["folder", "file", "text", "previous"]),
  required: z.boolean().default(false),
  description: line(200).optional(),
});
/** Text rules are for the model; `{ check, input }` ones are judged by the program before it starts. */
export const WorkflowPrecheckSchema = z.union([
  z.strictObject({ check: z.enum(["exists", "nonEmpty"]), input: WorkflowInputNameSchema }),
  line(300),
]);
export const DeliverableSchema = z.strictObject({
  id: key,
  path: DeliverablePathSchema,
  kind: z.enum(["md", "docx", "xlsx", "pptx", "any"]),
  sections: z.array(line(80)).max(20).optional(),
});
export const AcceptanceCheckSchema = z.enum([
  "exists",
  "sections",
  "citations",
  "manual",
  "minCitations",
  "sectionsSourced",
  "tableColumns",
  "hasChart",
  "fileNaming",
  "gbt7714",
  "verdict",
]);
export const AcceptanceSchema = z
  .strictObject({
    id: key,
    text: line(300).optional(),
    check: AcceptanceCheckSchema,
    deliverable: key.optional(),
    min: z.number().int().min(1).max(200).optional(),
    columns: z
      .array(line(80))
      .min(1)
      .max(20)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
  })
  .superRefine((item, ctx) => {
    if ((item.check === "minCitations") !== (item.min !== undefined))
      ctx.addIssue({
        code: "custom",
        message: item.min === undefined ? "acceptance_min_required" : "acceptance_min_forbidden",
        path: ["min"],
      });
    if ((item.check === "tableColumns") !== (item.columns !== undefined))
      ctx.addIssue({
        code: "custom",
        message:
          item.columns === undefined
            ? "acceptance_columns_required"
            : "acceptance_columns_forbidden",
        path: ["columns"],
      });
  });

/** Shared by saved contracts, dynamic plans and model-draft filtering. */
export function acceptanceTargetIssue(item: Acceptance, target: Deliverable): string | undefined {
  if ((item.check === "sections" || item.check === "sectionsSourced") && !target.sections?.length)
    return "sections_missing";
  const kind = target.kind === "any" ? target.path.split(".").at(-1)?.toLowerCase() : target.kind;
  if (item.check === "verdict" && kind !== "md") return "type_mismatch";
  if (item.check === "tableColumns" && kind !== "md" && kind !== "xlsx") return "type_mismatch";
  if (item.check === "hasChart" && !["md", "docx", "xlsx"].includes(kind ?? ""))
    return "type_mismatch";
  if (
    (item.check === "minCitations" ||
      item.check === "sectionsSourced" ||
      item.check === "gbt7714") &&
    !["md", "docx"].includes(kind ?? "")
  )
    return "type_mismatch";
  return undefined;
}
export const WorkflowStepOwnerSchema = z.union([
  z.strictObject({ botId: IdSchema }),
  z.strictObject({ role: line(64) }),
]);
export const WorkflowStepTaskSchema = z.union([
  line(16_000),
  z.strictObject({ skillId: IdSchema }),
]);
export const WorkflowStepSchema = z.strictObject({
  id: key,
  title: line(200),
  owner: WorkflowStepOwnerSchema,
  task: WorkflowStepTaskSchema,
  dependsOn: z.array(key).max(19).default([]),
  inputs: z
    .array(z.strictObject({ stepId: key, deliverableId: key }))
    .max(20)
    .optional(),
  maxFixRounds: z.number().int().min(0).max(2).optional(),
  deliverables: z.array(DeliverableSchema).max(10).default([]),
  acceptance: z.array(AcceptanceSchema).max(20).default([]),
});
export const WorkflowBudgetSchema = z.strictObject({
  costUsd: z.number().positive().max(10_000).optional(),
  modelRequests: z.number().int().min(1).max(1_000).optional(),
  activeSeconds: z.number().int().min(30).max(86_400).optional(),
});
export const SkillContractSchema = z
  .strictObject({
    inputs: z.array(WorkflowInputSchema).max(12).default([]),
    prechecks: z.array(WorkflowPrecheckSchema).max(12).default([]),
    deliverables: z.array(DeliverableSchema).max(10).default([]),
    acceptance: z.array(AcceptanceSchema).max(20).default([]),
    /** At most a few hard rules reach the model; the checker warns above three. */
    stop: z.array(line(300)).max(10).default([]),
    /** Fix rounds after a failed delivery check; the runtime never goes above two. */
    maxFixRounds: z.number().int().min(0).max(2).default(2),
    state: z.strictObject({ readPrevious: z.boolean().default(false) }).optional(),
    /** Categories the user confirms one by one (policy already asks for them; listed for the form). */
    approvals: z.array(CategorySchema).max(10).default([]),
    budget: WorkflowBudgetSchema.optional(),
    model: z
      .strictObject({
        tier: z.enum(["main", "cheap"]).default("main"),
        thinking: ThinkingLevelSchema.optional(),
      })
      .optional(),
    /** Deterministic group-only DAG; absent keeps every existing workflow unchanged. */
    steps: z.array(WorkflowStepSchema).min(1).max(20).optional(),
    /**
     * These steps were saved from a passed dynamic plan. A run re-submits them as a plan
     * through the same validation, confirmation, budget and replanning as a coordinator's plan;
     * the estimate only feeds that confirmation rule and never grants budget.
     */
    planTemplate: z
      .strictObject({ estimatedCostUsd: z.number().finite().nonnegative().max(10_000) })
      .optional(),
  })
  .superRefine((contract, issues) => {
    const fail = (message: string, path: PropertyKey[]) =>
      issues.addIssue({ code: "custom", message, path });
    const unique = (values: string[], what: string, path: (index: number) => PropertyKey[]) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) fail(`Duplicate ${what}`, path(index));
        seen.add(value);
      });
    };
    unique(
      contract.inputs.map((i) => i.name),
      "input",
      (index) => ["inputs", index, "name"],
    );
    unique(
      contract.deliverables.map((d) => d.id),
      "deliverable",
      (index) => ["deliverables", index, "id"],
    );
    unique(
      contract.acceptance.map((a) => a.id),
      "acceptance",
      (index) => ["acceptance", index, "id"],
    );
    const inputs = new Set(contract.inputs.map((i) => i.name));
    contract.prechecks.forEach((rule, index) => {
      if (typeof rule !== "string" && !inputs.has(rule.input))
        fail("Pre-check names no input", ["prechecks", index, "input"]);
    });
    const deliverables = new Map(contract.deliverables.map((d) => [d.id, d]));
    contract.acceptance.forEach((item, index) => {
      if (item.check === "manual") return;
      const target = item.deliverable ? deliverables.get(item.deliverable) : undefined;
      if (!target) fail("Acceptance names no deliverable", ["acceptance", index, "deliverable"]);
      else if (acceptanceTargetIssue(item, target))
        fail("Acceptance target incompatible", ["acceptance", index, "check"]);
    });
    const steps = contract.steps ?? [];
    if (contract.planTemplate && !steps.length) fail("Plan template needs steps", ["steps"]);
    unique(
      steps.map((step) => step.id),
      "step",
      (index) => ["steps", index, "id"],
    );
    const stepIds = new Set(steps.map((step) => step.id));
    steps.forEach((step, index) => {
      unique(step.dependsOn, "step dependency", (dependency) => [
        "steps",
        index,
        "dependsOn",
        dependency,
      ]);
      step.dependsOn.forEach((dependency, dependencyIndex) => {
        if (dependency === step.id)
          fail("Step cannot depend on itself", ["steps", index, "dependsOn", dependencyIndex]);
        else if (!stepIds.has(dependency))
          fail("Dependency names no step", ["steps", index, "dependsOn", dependencyIndex]);
      });
      unique(
        step.deliverables.map((item) => item.id),
        "step deliverable",
        (deliverable) => ["steps", index, "deliverables", deliverable, "id"],
      );
      unique(
        step.acceptance.map((item) => item.id),
        "step acceptance",
        (acceptance) => ["steps", index, "acceptance", acceptance, "id"],
      );
      const produced = new Map(step.deliverables.map((item) => [item.id, item]));
      step.acceptance.forEach((item, acceptanceIndex) => {
        if (item.check === "manual") return;
        const target = item.deliverable ? produced.get(item.deliverable) : undefined;
        if (!target)
          fail("Step acceptance names no step deliverable", [
            "steps",
            index,
            "acceptance",
            acceptanceIndex,
            "deliverable",
          ]);
        else if (acceptanceTargetIssue(item, target))
          fail("Acceptance target incompatible", [
            "steps",
            index,
            "acceptance",
            acceptanceIndex,
            "check",
          ]);
      });
    });
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(steps.map((step, index) => [step.id, { step, index }]));
    const dependedOn = new Set(steps.flatMap((step) => step.dependsOn));
    for (const dependency of dependedOn) {
      const producer = byId.get(dependency);
      if (producer && producer.step.deliverables.length === 0)
        fail("Dependency step produces no deliverable", ["steps", producer.index, "deliverables"]);
    }
    // Every prerequisite id/status and every declared artifact path must fit the structured
    // hand-off context. Reject an unrepresentable fan-in instead of dropping later dependencies.
    steps.forEach((current, index) => {
      current.inputs?.forEach((input, inputIndex) => {
        if (
          !current.dependsOn.includes(input.stepId) ||
          !byId.get(input.stepId)?.step.deliverables.some((item) => item.id === input.deliverableId)
        )
          fail("Step input names no dependency deliverable", [
            "steps",
            index,
            "inputs",
            inputIndex,
          ]);
      });
      const required = current.dependsOn.map((id) => ({
        id,
        status: "passed",
        artifacts: byId.get(id)?.step.deliverables.map((item) => item.path) ?? [],
      }));
      if (JSON.stringify(required).length > 4_500)
        fail("Dependency references exceed step context limit", ["steps", index, "dependsOn"]);
    });
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      const current = byId.get(id);
      if (!current) return false;
      visiting.add(id);
      for (const dependency of current.step.dependsOn)
        if (visit(dependency)) {
          fail("Workflow step dependency cycle", ["steps", current.index, "dependsOn"]);
          return true;
        }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    for (const id of stepIds) if (visit(id)) break;
  });
/** Positive integer, written as a string in YAML (`pibot-version: "2"`). */
export const SkillVersionSchema = z.number().int().positive().max(100_000);
/** A built-in workflow's real-world verification, parsed from `pibot-verified`. */
export const WorkflowVerificationSchema = z.strictObject({
  date: z.iso.date(),
  note: line(300).refine(
    (value) => /^.+ \/ .+$/u.test(value),
    "A Chinese and English note separated by ` / ` is required",
  ),
});
/** Exact frontmatter form: `YYYY-MM-DD · Chinese basis / English basis`. */
export const SkillVerifiedMetadataSchema = z
  .string()
  .max(340)
  .regex(/^\d{4}-\d{2}-\d{2} · .+ \/ .+$/u)
  .transform((value) => {
    const separator = value.indexOf(" · ");
    return { date: value.slice(0, separator), note: value.slice(separator + 3) };
  })
  .pipe(WorkflowVerificationSchema);
/**
 * Problems a contract skill can have; the skill still loads and runs as an ordinary skill. Codes
 * only (the interface translates them); `contract_invalid` also means it cannot be run.
 */
export const WorkflowWarningSchema = z.enum([
  "contract_invalid",
  "version_invalid",
  "verification_invalid",
  "body_too_long",
  "too_many_stop_rules",
  "no_deliverables",
  "no_acceptance",
]);
/** A run request's values: input name → absolute path (folder / file) or text. */
export const WorkflowInputValuesSchema = z
  .record(WorkflowInputNameSchema, z.string().max(4000))
  .refine((v) => Object.keys(v).length <= 12, "Too many inputs");
/** Parameter name → value for `{name}` in the body (`pibot-params`); missing ones use defaults. */
export const WorkflowParamValuesSchema = z
  .record(z.string().regex(/^[\p{L}\p{N}_]{1,40}$/u), z.string().max(1000).refine(plainText))
  .refine((v) => Object.keys(v).length <= 20, "Too many parameters");
/**
 * Routine binding: run a workflow skill of the routine's Bot instead of free text. Folder and
 * file inputs are absolute paths; `previous` inputs come from the previous period.
 */
export const WorkflowBindingSchema = z.strictObject({
  skillId: IdSchema,
  params: WorkflowParamValuesSchema.default({}),
  inputs: WorkflowInputValuesSchema.default({}),
});
/** Why the program did not start a run (pre-checks before the model). */
export const WorkflowPrecheckFailureSchema = z.strictObject({
  input: WorkflowInputNameSchema,
  reason: z.enum(["required", "missing", "empty", "not_folder", "not_file", "invalid"]),
});

export type SkillContract = z.output<typeof SkillContractSchema>;
export type WorkflowInput = z.output<typeof WorkflowInputSchema>;
export type Deliverable = z.output<typeof DeliverableSchema>;
export type Acceptance = z.output<typeof AcceptanceSchema>;
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;
export type WorkflowStep = z.output<typeof WorkflowStepSchema>;
export type WorkflowBudget = z.output<typeof WorkflowBudgetSchema>;
export type WorkflowVerification = z.output<typeof WorkflowVerificationSchema>;
export type WorkflowWarning = z.infer<typeof WorkflowWarningSchema>;
export type WorkflowBinding = z.output<typeof WorkflowBindingSchema>;
export type WorkflowPrecheckFailure = z.infer<typeof WorkflowPrecheckFailureSchema>;
