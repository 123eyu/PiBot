// The policy entry a phone's offline runtime uses (`@pibot/policy/portable`). It has no
// Node builtins, wasm or filesystem facts: a phone can only run the few categories below, decided
// from the request alone by the same intrinsic rules as the computer. Every other category is
// refused, so a tool that is not meant for the phone can never be allowed there by accident.
import { z } from "zod";
import { ownBackgroundDecision } from "../core/background-decision.ts";
import { createPolicyTrace } from "../core/explain.ts";
import { intrinsicDecision } from "../core/intrinsic-decisions.ts";
import type { PolicyResult } from "../core/types.ts";

export const PortablePolicyRequestSchema = z.discriminatedUnion("category", [
  z.strictObject({ category: z.literal("background") }),
  z.strictObject({
    category: z.literal("phone_data"),
    operation: z.enum(["media", "media_get", "sms_code", "calls", "notifications"]),
  }),
  /** ask_user: a choice card shown on the phone itself. */
  z.strictObject({ category: z.literal("planning") }),
  /** memory_add on the phone only proposes; the user confirms on the computer later. */
  z.strictObject({ category: z.literal("memory_proposal") }),
]);
export type PortablePolicyRequest = z.infer<typeof PortablePolicyRequestSchema>;
export type PortablePolicyResult = Pick<PolicyResult, "decision" | "reason" | "explanation">;

export function decidePortable(input: unknown): PortablePolicyResult {
  const trace = createPolicyTrace();
  const parsed = PortablePolicyRequestSchema.safeParse(input);
  if (!parsed.success) {
    const { decision, reason, explanation } = trace.result(
      {
        decision: "deny",
        reason: "category_unavailable_on_phone",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
    return { decision, reason, explanation };
  }
  if (parsed.data.category === "background") return ownBackgroundDecision(trace);
  // A proposal only creates a pending card on the computer, the same rule as a skill proposal.
  const result =
    parsed.data.category === "memory_proposal"
      ? trace.result(
          {
            decision: "allow",
            reason: "user_confirmation_required",
            risk: "normal",
            facts: [],
            canRemember: false,
          },
          "intrinsic",
        )
      : intrinsicDecision({ request: parsed.data }, trace);
  if (!result) throw new Error("portable_policy_incomplete");
  return { decision: result.decision, reason: result.reason, explanation: result.explanation };
}

export { decideRunnerPortable } from "./runner.ts";
