import type { PolicyTrace } from "./explain.ts";
import type { PolicyResult } from "./types.ts";

export function deny(
  result: PolicyResult,
  reason: string,
  trace: PolicyTrace,
  axis: "boundary" | "category" | "level" | "connector" = "boundary",
): PolicyResult {
  result.decision = "deny";
  result.reason = reason;
  result.canRemember = false;
  // A refused call opens nothing; execution must never find roots left on a deny.
  delete result.outsideWrites;
  delete result.outsideWriteRoots;
  return trace.result(result, axis);
}
