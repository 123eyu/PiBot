import { type ApprovalFact, sameAppId } from "@pibot/protocol-base";
import { createPolicyTrace, type PolicyTrace } from "../core/explain.ts";
import type { EvaluationInput, PolicyResult, PolicyStep } from "../core/types.ts";

type ComputerRequest = Extract<EvaluationInput["request"], { category: "computer" }>;

/**
 * Operating the computer. The ceiling is the usual level; "always" only
 * skips the card for apps on the Bot's always-list, and screenshot clicks (coordinates) are never
 * covered by "always". An "ask" here means "needs a run grant": brain's computer gate checks an
 * existing grant or routine preauthorization before it shows the card. Nothing is rememberable
 * through the generic grants table; the always-list lives in its own repository.
 */
export function evaluateComputer(
  input: EvaluationInput & { request: ComputerRequest },
  trace: PolicyTrace = createPolicyTrace(),
): PolicyResult {
  if (!trace.steps.length) trace.step("category", "computer", "info");
  const request = input.request;
  const apps = request.apps ?? [];
  const facts: ApprovalFact[] = apps.map((app) => ({ kind: "program", value: app }));
  if (request.coordinates) facts.push({ kind: "warning", value: "computer_coordinates" });
  const result = (
    decision: PolicyResult["decision"],
    reason: string,
    axis: PolicyStep["axis"] = "grant",
  ): PolicyResult =>
    trace.result(
      {
        decision,
        reason,
        risk: "normal",
        facts,
        canRemember: false,
      },
      axis,
    );
  const level = input.botOverrides?.computer ?? input.settings.levels.computer;
  trace.step("level", "permission_level", "info", {
    level,
    source:
      input.permissionSources?.computer ??
      (input.botOverrides?.computer === undefined ? "default" : "bot"),
  });
  if (level === "never") return result("deny", "permission_never", "level");
  if (level !== "always") return result("ask", "permission_ask", "level");
  if (request.coordinates) return result("ask", "computer_coordinates_need_grant", "boundary");
  const always = request.alwaysApps ?? [];
  // An "always" level without an app list is not a blanket pass.
  if (apps.length && apps.every((app) => always.some((held) => sameAppId(held, app))))
    return result("allow", "computer_always_list");
  return result("ask", "computer_app_not_in_always_list");
}
