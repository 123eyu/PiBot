import type { GroupWorkflowStepRecord } from "@pibot/storage";

/** Reuse recorded member conclusions; no new model call or claim that their prose was verified. */
export function planConclusionLines(states: readonly GroupWorkflowStepRecord[]) {
  const lines = new Set<string>();
  // The final step normally synthesizes upstream work; prefer its summary to intermediate notes.
  for (const state of [...states].reverse()) {
    if (state.status !== "passed") continue;
    for (const item of state.deliverables) {
      if (
        !item ||
        typeof item !== "object" ||
        !("summary" in item) ||
        typeof item.summary !== "string"
      )
        continue;
      for (const raw of item.summary.slice(0, 4000).split(/\r?\n|(?<=[。！？.!?])\s+/u)) {
        const line = raw
          .replace(/^[\s#>*•-]+/u, "")
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .trim()
          .slice(0, 240);
        if (line) lines.add(line);
        if (lines.size === 3) return [...lines];
      }
    }
  }
  return [...lines];
}
