import { outputBasename } from "@pibot/brain/orchestration-kit";
import {
  type GroupPlan,
  GroupPlanSchema,
  type PlanRelaxation,
  PlanRelaxationsSchema,
  RpcError,
} from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord } from "@pibot/storage";

type Output = GroupPlan["steps"][number]["deliverables"][number];

function correspondingOutputs(before: Output[], after: Output[]) {
  const matches = new Map<string, string>();
  const available = new Map(after.map((item) => [item.id, item]));
  const bind = (prior: Output, next: Output) => {
    matches.set(prior.id, next.id);
    available.delete(next.id);
  };
  // Reserve every stable identity before fallback so iteration order cannot steal a match.
  for (const prior of before) {
    const next = available.get(prior.id);
    if (next) bind(prior, next);
  }
  const equivalent = (prior: Output, next: Output) =>
    prior.kind === next.kind && JSON.stringify(prior.sections) === JSON.stringify(next.sections);
  for (const same of [
    (prior: Output, next: Output) => prior.path === next.path && equivalent(prior, next),
    equivalent,
  ]) {
    const unmatched = before.filter((item) => !matches.has(item.id));
    for (const prior of unmatched) {
      const candidates = [...available.values()].filter((next) => same(prior, next));
      const next = candidates.length === 1 ? candidates[0] : undefined;
      // Ambiguous semantic twins must not consume a later output's exact-path counterpart.
      if (next && unmatched.filter((item) => same(item, next)).length === 1) bind(prior, next);
    }
  }
  return matches;
}

/** Compare effective requirements, including checks inherited from methods, never model prose. */
export function planRelaxations(
  record: GroupWorkflowRunRecord,
  after: GroupPlan,
): PlanRelaxation[] {
  const before = GroupPlanSchema.parse((record.workflow as { dynamicPlan?: unknown }).dynamicPlan);
  const changes: PlanRelaxation[] = [];
  const steps = new Map(after.steps.map((step) => [step.id, step]));
  for (const old of before.steps) {
    const next = steps.get(old.id);
    const add = (
      kind: PlanRelaxation["kind"],
      targetId: string,
      detail: NonNullable<PlanRelaxation["detail"]>,
    ) => changes.push({ stepId: old.id, stepTitle: old.title, targetId, kind, detail });
    if (old.method && old.method !== next?.method)
      add(
        "method",
        "method",
        next?.method
          ? { change: "method_changed", before: old.method, after: next.method }
          : { change: "method_removed", method: old.method },
      );
    const outputIds = correspondingOutputs(old.deliverables, next?.deliverables ?? []);
    const outputs = new Map(next?.deliverables.map((item) => [item.id, item]) ?? []);
    for (const output of old.deliverables) {
      const replacement = outputs.get(outputIds.get(output.id) ?? output.id);
      if (!replacement) continue;
      if (output.id !== replacement.id)
        add("output", output.id, { change: "output_id", before: output.id, after: replacement.id });
      if (output.path !== replacement.path)
        add("output", output.id, {
          change:
            outputBasename(output.path) === outputBasename(replacement.path)
              ? "output_path"
              : "output_name",
          before: output.path,
          after: replacement.path,
        });
    }
    const checks = new Map(next?.acceptance.map((item) => [item.id, item]) ?? []);
    const usedChecks = new Set<string>();
    for (const check of old.acceptance) {
      const target = check.deliverable
        ? (outputIds.get(check.deliverable) ?? check.deliverable)
        : undefined;
      const candidates = [...checks.values()].filter(
        (item) =>
          !usedChecks.has(item.id) &&
          !old.acceptance.some((prior) => prior.id === item.id) &&
          item.check === check.check &&
          item.deliverable === target,
      );
      const equivalent = candidates.filter(
        ({ id: _id, ...item }) =>
          JSON.stringify(item) ===
          JSON.stringify((({ id: _oldId, ...prior }) => prior)({ ...check, deliverable: target })),
      );
      const replacement =
        checks.get(check.id) ??
        (equivalent.length === 1
          ? equivalent[0]
          : candidates.length === 1
            ? candidates[0]
            : undefined);
      if (replacement) {
        usedChecks.add(replacement.id);
        if (check.id !== replacement.id)
          add("check", check.id, { change: "check_id", before: check.id, after: replacement.id });
      }
      if (!replacement) add("check", check.id, { change: "check_removed", check: check.check });
      else if (check.check !== replacement.check)
        add("check", check.id, {
          change: "check_changed",
          before: check.check,
          after: replacement.check,
        });
      else {
        if (target !== replacement.deliverable)
          add("check", check.id, {
            change: "target",
            before: check.deliverable,
            after: replacement.deliverable,
          });
        if (check.min !== undefined && replacement.min !== undefined && check.min > replacement.min)
          add("check", check.id, { change: "minimum", before: check.min, after: replacement.min });
        const removed = check.columns?.filter((column) => !replacement.columns?.includes(column));
        if (removed?.length) add("check", check.id, { change: "columns", removed });
        if (check.check === "manual" && check.text !== replacement.text)
          add("check", check.id, { change: "manual" });
      }
    }
    for (const output of old.deliverables) {
      const replacement = outputs.get(outputIds.get(output.id) ?? output.id);
      if (!replacement) add("output", output.id, { change: "output_removed", path: output.path });
      else {
        if (output.kind !== replacement.kind)
          add("output", output.id, {
            change: "output_kind",
            before: output.kind,
            after: replacement.kind,
          });
        const removed = output.sections?.filter(
          (section) => !replacement.sections?.includes(section),
        );
        if (removed?.length) add("output", output.id, { change: "sections", removed });
      }
    }
  }
  return PlanRelaxationsSchema.parse(changes);
}

/** Re-evaluate after asynchronous preflights; a stale acknowledgement cannot authorize new losses. */
export function assertRelaxationConfirmation(
  record: GroupWorkflowRunRecord | undefined,
  card: import("@pibot/protocol-base").GroupPlanCard,
) {
  const changes = record ? planRelaxations(record, card.plan) : [];
  if (JSON.stringify(changes) !== JSON.stringify(card.relaxations ?? []))
    throw new RpcError(-32602, "group_plan_relaxation_changed");
  if (changes.length && !card.confirmedByUser)
    throw new RpcError(-32602, "group_plan_relaxation_confirmation_required");
}
