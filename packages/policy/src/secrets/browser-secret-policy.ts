import { recordPolicyStep } from "../core/explain.ts";
import type { PolicyResult } from "../core/types.ts";

/** Maintainers 2026-11-11: browser handles require a person for every use, including YOLO and routines. */
export function browserSecretPolicy(result: PolicyResult, uses: number): PolicyResult {
  if (!uses || result.decision === "deny") return result;
  const next = {
    ...result,
    decision: "ask" as const,
    reason: "browser_secret_confirmation",
    canRemember: false,
  };
  delete next.grantScope;
  recordPolicyStep(next, "secret", "browser_secret_confirmation");
  return next;
}
