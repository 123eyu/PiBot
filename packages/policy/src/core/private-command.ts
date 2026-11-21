import { privateCommandHosts } from "../targets/private-network.ts";
import { PRIVATE_NETWORK_REASON } from "./confirmation-reasons.ts";
import { mustAskNow } from "./connection-confirmation.ts";
import type { PolicyTrace } from "./explain.ts";
import type { EvaluationInput, PolicyResult } from "./types.ts";

/**
 * Maintainers 2026-11-14: a sandboxed command that names a host on the user's own network asks once per
 * host and task; the person's answer lets the sandbox proxy reach it for the rest of the run.
 *
 * Applied after every other rule, and the hosts are facts whether or not they are approved yet:
 * the call a person approves must re-prepare to the same facts, or execution sees "changed". A
 * card that already must be answered by a person (danger, outside the sandbox, …) keeps its own
 * reason and shows the hosts too; brain then opens them on that answer as well. Anything weaker
 * (allow, an ordinary or YOLO-releasable ask) becomes the local-network card.
 */
export function privateCommandDecision(
  input: EvaluationInput,
  result: PolicyResult,
  trace: PolicyTrace,
): PolicyResult {
  const request = input.request;
  if (request.category !== "run_command" || !request.privateNetwork || result.decision === "deny")
    return result;
  const hosts = privateCommandHosts(result.analysis);
  if (!hosts.length) return result;
  result.privateTargets = hosts;
  for (const host of hosts) result.facts.push({ kind: "network", value: host });
  const approved = request.privateNetwork.approved;
  if (hosts.every((host) => approved.includes(host))) {
    trace.step("boundary", "private_network_run_approved", "info");
    return result;
  }
  if (mustAskNow(result) && result.reason !== "command_network_confirmation") return result;
  result.decision = "ask";
  result.reason = PRIVATE_NETWORK_REASON;
  result.canRemember = false;
  delete result.grantScope;
  delete result.scriptScope;
  delete result.commandNetwork;
  return trace.result(result, "boundary");
}
