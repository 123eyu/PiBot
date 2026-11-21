import type { CommandAnalysis } from "../core/types.ts";
import { uncertain } from "./command-facts.ts";

export function createAnalysisBudget(result: CommandAnalysis) {
  const deadline = performance.now() + 100;
  let remaining = 100_000;
  return {
    deadline,
    check() {
      if (--remaining >= 0 && performance.now() <= deadline) return true;
      uncertain(result, "analysis_budget_exceeded");
      return false;
    },
  };
}
export type AnalysisBudget = ReturnType<typeof createAnalysisBudget>;
