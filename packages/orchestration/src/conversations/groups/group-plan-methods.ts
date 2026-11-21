import type { Acceptance, Bot, Deliverable, SkillContract } from "@pibot/protocol-base";
import type { PlanIssue } from "./group-plan-validation.ts";
import { withVerdictRequirement } from "./group-plan-verdicts.ts";

/** The owner's method contract by key or skill name; undefined when it has none. */
export type MethodLookup = (botId: string, method: string) => Promise<SkillContract | undefined>;
export type MethodKeys = (botId: string) => Promise<readonly string[]>;
type MethodIssue = PlanIssue & { availableMethods?: readonly string[] };

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  !!value && typeof value === "object" && !Array.isArray(value);
const idOf = (value: unknown) => (isObject(value) && typeof value.id === "string" ? value.id : "");
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** The method's entries first, then the plan's extra ones; the plan cannot drop a method entry. */
const union = (method: readonly string[], plan: unknown) => [
  ...method,
  ...strings(plan).filter((item) => !method.includes(item)),
];

/** Same owner rule as D1 (`validateGroupPlan`): one active member by id or unique role. */
function ownerOf(owner: unknown, members: readonly Bot[]) {
  if (!isObject(owner)) return undefined;
  const candidates = members.filter(
    (bot) =>
      !bot.archivedAt &&
      (typeof owner.botId === "string"
        ? bot.id === owner.botId
        : typeof owner.role === "string" && bot.role?.id === owner.role),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function deliverables(
  plan: unknown,
  method: readonly Deliverable[],
  conflicts: PlanIssue["path"][],
  renamed: Map<string, string>,
) {
  const own = Array.isArray(plan) ? plan : [];
  const byId = new Map(own.map((item, index) => [idOf(item), { item, index }]));
  const methodIds = new Set(method.map((item) => item.id));
  // Mac acceptance 2026-11-20: the coordinator called the test report "qa-report" while the
  // method calls it "report", so the step asked for both 测试报告.md and qa-report.md. A method
  // deliverable no planned id matches takes the planned one of the same kind that matches none.
  const spare = own
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isObject(item) && !methodIds.has(idOf(item)));
  const paired = new Set<number>();
  const merged = method.map((item) => {
    let entry = byId.get(item.id);
    let byKind = false;
    if (!entry) {
      entry = spare.find(
        (candidate) =>
          !paired.has(candidate.index) &&
          isObject(candidate.item) &&
          candidate.item.kind === item.kind,
      );
      if (entry) {
        paired.add(entry.index);
        byKind = true;
        // Windows acceptance 2026-11-20: the step's own checks and later steps' inputs still named
        // the planned id ("test_report"), so every plan failed with plan_deliverable_missing.
        const planned = idOf(entry.item);
        if (planned) renamed.set(planned, item.id);
      }
    }
    if (!entry || !isObject(entry.item)) return { ...item };
    const mine = entry.item;
    // A different file type would void the method's checks; the path and extra sections may differ.
    if (mine.kind !== undefined && mine.kind !== item.kind)
      conflicts.push(["deliverables", entry.index, "kind"]);
    const sections = union(item.sections ?? [], mine.sections);
    return {
      ...mine,
      id: item.id,
      kind: item.kind,
      // Paired by kind only: the method's own text names its file, so its path stands.
      ...(byKind ? { path: item.path } : {}),
      ...(sections.length ? { sections } : {}),
    };
  });
  return [
    ...merged,
    ...own.filter((item, index) => !methodIds.has(idOf(item)) && !paired.has(index)),
  ];
}

function acceptance(plan: unknown, method: readonly Acceptance[], conflicts: PlanIssue["path"][]) {
  const own = Array.isArray(plan) ? plan : [];
  const byId = new Map(own.map((item, index) => [idOf(item), { item, index }]));
  const merged = method.map((item) => {
    const entry = byId.get(item.id);
    if (!entry || !isObject(entry.item)) return { ...item };
    const mine = entry.item;
    // Same id must stay the same check on the same file; only stricter limits are taken.
    if (mine.check !== item.check || (mine.deliverable ?? undefined) !== item.deliverable) {
      conflicts.push([
        "acceptance",
        entry.index,
        mine.check !== item.check ? "check" : "deliverable",
      ]);
      return { ...item };
    }
    return {
      ...item,
      ...(typeof mine.text === "string" ? { text: mine.text } : {}),
      ...(item.min !== undefined
        ? { min: typeof mine.min === "number" ? Math.max(item.min, mine.min) : item.min }
        : {}),
      ...(item.columns ? { columns: union(item.columns, mine.columns) } : {}),
    };
  });
  const ids = new Set(method.map((item) => item.id));
  return [...merged, ...own.filter((item) => !ids.has(idOf(item)))];
}

/**
 * A plan step may name one of its owner's methods (`method`); the program, not the
 * model, brings that method's deliverables and acceptance into the step before D1 validates the
 * plan, so a referenced method's checks cannot be forgotten or loosened. The plan may add its own
 * items, sections, columns and a higher citation minimum. Applying it to an already merged step
 * gives the same step. A replan may explicitly replace requirements; the program compares the
 * effective result with the old plan and requires the user to confirm every relaxation. An unresolved
 * owner is left for D1 to report; the raw input is only read, never trusted.
 */
export async function expandPlanMethods(
  value: unknown,
  members: readonly Bot[],
  lookup: MethodLookup,
  available: MethodKeys,
  replanning = false,
  retained: ReadonlySet<string> = new Set(),
): Promise<{ ok: true; value: unknown } | { ok: false; issues: MethodIssue[] }> {
  if (!isObject(value) || !Array.isArray(value.steps)) return { ok: true, value };
  const issues: MethodIssue[] = [];
  const steps: unknown[] = [];
  const roles = new Set(members.filter((bot) => !bot.archivedAt).map((bot) => bot.role?.id));
  const keys = new Map<string, Promise<readonly string[]>>();
  /** Per step: planned deliverable id → the method's id it was paired with. */
  const renames = new Map<string, Map<string, string>>();
  for (const [index, step] of value.steps.entries()) {
    const keep = isObject(step) && typeof step.id === "string" && retained.has(step.id);
    if (keep) {
      steps.push(step);
      continue;
    }
    const owner = isObject(step) ? ownerOf(step.owner, members) : undefined;
    if (!isObject(step) || typeof step.method !== "string" || !step.method.trim() || !owner) {
      steps.push(keep ? step : withVerdictRequirement(step, owner));
      continue;
    }
    const method = step.method.normalize("NFKC").trim();
    const slash = method.indexOf("/");
    // Role prefixes repair a hint format; they never select whose skills or authority to use.
    const key = slash >= 0 && roles.has(method.slice(0, slash)) ? method.slice(slash + 1) : method;
    const contract = key ? await lookup(owner.id, key) : undefined;
    // A multi-step workflow is a plan of its own, not one step's method.
    if (!contract || contract.steps?.length || !contract.deliverables.length) {
      let listed = keys.get(owner.id);
      if (!listed) {
        listed = available(owner.id);
        keys.set(owner.id, listed);
      }
      issues.push({
        code: "plan_method_unavailable",
        path: ["steps", index, "method"],
        availableMethods: await listed,
      });
      steps.push(step);
      continue;
    }
    const conflicts: PlanIssue["path"][] = [];
    const renamed = new Map<string, string>();
    const mergedDeliverables =
      replanning && Array.isArray(step.deliverables)
        ? step.deliverables
        : deliverables(step.deliverables, contract.deliverables, conflicts, renamed);
    if (renamed.size && typeof step.id === "string") renames.set(step.id, renamed);
    const ownAcceptance =
      renamed.size && Array.isArray(step.acceptance)
        ? step.acceptance.map((item) =>
            isObject(item) && typeof item.deliverable === "string" && renamed.has(item.deliverable)
              ? { ...item, deliverable: renamed.get(item.deliverable) }
              : item,
          )
        : step.acceptance;
    steps.push(
      withVerdictRequirement(
        {
          ...step,
          deliverables: mergedDeliverables,
          acceptance:
            replanning && Array.isArray(step.acceptance)
              ? step.acceptance
              : acceptance(ownAcceptance, contract.acceptance, conflicts),
        },
        keep ? undefined : owner,
      ),
    );
    for (const path of conflicts)
      issues.push({
        code: "plan_method_conflict",
        path: ["steps", index, ...path],
        expected:
          path[0] === "acceptance"
            ? "同名验收项必须保留方法的检查类型和交付物绑定；可省略该覆盖项继承方法，新增检查用不同 id / A same-id check must keep the method's check type and deliverable; omit the override to inherit it, and use a distinct id for an additional check"
            : "同名交付物必须保留方法的文件类型；只改 path 或追加 sections / A same-id deliverable must keep the method's file type; change only path or add sections",
      });
  }
  if (issues.length) return { ok: false, issues: issues.slice(0, 20) };
  // Later steps that read a renamed deliverable follow it to the method's id.
  const linked = renames.size
    ? steps.map((step) =>
        isObject(step) && Array.isArray(step.inputs)
          ? {
              ...step,
              inputs: step.inputs.map((input) => {
                if (!isObject(input) || typeof input.stepId !== "string") return input;
                const next =
                  typeof input.deliverableId === "string"
                    ? renames.get(input.stepId)?.get(input.deliverableId)
                    : undefined;
                return next ? { ...input, deliverableId: next } : input;
              }),
            }
          : step,
      )
    : steps;
  return { ok: true, value: { ...value, steps: linked } };
}
