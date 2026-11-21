import type { PolicyResult, PolicyStep } from "./types.ts";

export interface PolicyTrace {
  readonly steps: PolicyStep[];
  step(
    axis: PolicyStep["axis"],
    code: string,
    effect: PolicyStep["effect"],
    extra?: Pick<PolicyStep, "level" | "source">,
  ): void;
  result<T extends Omit<PolicyResult, "explanation">>(
    result: T,
    axis: PolicyStep["axis"],
  ): T & PolicyResult;
}

/** Each decision owns its trace; a transform copies only the small step array, never facts. */
export function createPolicyTrace(previous?: readonly PolicyStep[]): PolicyTrace {
  const steps = previous ? [...previous] : [];
  const step: PolicyTrace["step"] = (axis, code, effect, extra) => {
    steps.push({ axis, code, effect, ...extra });
  };
  return {
    steps,
    step,
    result(result, axis) {
      // Only policy-owned result codes belong here, never caller-supplied failure text.
      step(axis, result.reason, result.decision);
      const explained = Object.assign(result, { explanation: steps });
      return explained;
    },
  };
}

/** Derived decisions retain their original fields and own their small trace array. */
export function explainPolicyResult(
  result: Omit<PolicyResult, "explanation"> & { explanation?: PolicyStep[] },
  axis: PolicyStep["axis"],
  code: string,
  effect: PolicyStep["effect"] = result.decision,
): PolicyResult {
  const trace = createPolicyTrace(result.explanation);
  if (!trace.steps.length && axis === "yolo" && result.decision === "allow")
    trace.step("grant", "confirmation_required", "ask");
  trace.step(axis, code, effect);
  if (effect === "narrow") trace.step(axis, "current_policy_decision", result.decision);
  return { ...result, explanation: trace.steps };
}

/** Existing mutable adapters keep their object identity; their trace never aliases its source. */
export function recordPolicyStep(
  result: PolicyResult,
  axis: PolicyStep["axis"],
  code: string,
  effect: PolicyStep["effect"] = result.decision,
): void {
  result.explanation = explainPolicyResult(result, axis, code, effect).explanation;
}
