import type { GitEntryFacts } from "@pibot/protocol-base";
import type { PolicyTrace } from "./explain.ts";
import type { EvaluationInput, PolicyResult } from "./types.ts";

export const GIT_ENTRY_CONFIRMATION_REASON = "git_entry_confirmation_required";

/**
 * An ordinary Git command that would run a project
 * hook or executable config entry is asked about each time, danger risk, never remembered and
 * with no grant scope, so always / YOLO / old grants / routine pre-approval cannot answer it.
 * Forms whose entries cannot be bound are refused. The facts carry paths and hashes only.
 */
export function gitEntryDecision(
  input: EvaluationInput,
  facts: GitEntryFacts,
  result: PolicyResult,
  trace: PolicyTrace,
): PolicyResult {
  if (input.request.category !== "run_command" || input.request.background || input.request.stdin)
    return trace.result(
      { ...result, decision: "deny", reason: "git_entry_unsupported_target", canRemember: false },
      "boundary",
    );
  if (facts.status === "unsupported" || facts.reason !== "entries_found" || !facts.entries.length) {
    const reason = facts.reason === "entries_found" ? "scan_incomplete" : facts.reason;
    delete result.grantScope;
    return trace.result(
      { ...result, decision: "deny", reason: `git_entry_${reason}`, canRemember: false },
      "boundary",
    );
  }
  result.decision = "ask";
  result.reason = GIT_ENTRY_CONFIRMATION_REASON;
  result.risk = "danger";
  result.canRemember = false;
  delete result.grantScope;
  for (const entry of facts.entries)
    result.facts.push({
      kind: "program",
      value: `${entry.kind === "hook" ? "hook" : "config"} ${entry.name} · ${entry.source} · sha256 ${entry.sha256.slice(0, 12)}`,
      risk: "danger",
    });
  result.facts.push({ kind: "warning", value: "git_entry_once", risk: "danger" });
  return trace.result(result, "danger");
}
