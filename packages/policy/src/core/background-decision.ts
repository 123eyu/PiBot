import type { PolicyTrace } from "./explain.ts";
export function ownBackgroundDecision(trace: PolicyTrace) {
  return trace.result(
    {
      decision: "allow" as const,
      reason: "own_background_commands",
      risk: "normal" as const,
      facts: [],
      canRemember: false,
    },
    "intrinsic",
  );
}
