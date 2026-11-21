import type { EvaluationInput, PolicyResult } from "@pibot/policy";
import { explainPolicyResult } from "@pibot/policy";
import type { LocalService } from "../../local-service.ts";

/**
 * Search text consumes both read and listing consent in one existing tool approval card.
 *
 * The listing decision reuses the root call's own policy input instead of rebuilding a
 * smaller one. The rebuilt input dropped the execution target's `realpath`, so a remote folder
 * could not be resolved and every search through a runner was refused as
 * `path_or_url_unresolved`; it also handed this desktop's skills folder to a decision about the
 * other machine's paths. A remote workplace therefore needs no branch here — `realpath`, the
 * missing `sensitiveReadRoots` and the absent `skillsRoot` already come from the remote-workplace
 * handling in the caller, and the runner guards its own disk.
 */
export async function searchRootPolicyResult(
  local: LocalService,
  result: PolicyResult,
  policyInput: Omit<EvaluationInput, "request">,
  signal: AbortSignal,
): Promise<PolicyResult> {
  if (result.decision === "deny" || !result.path) return result;
  const policy = await local.getPolicy(signal);
  const listing = await policy.evaluate({
    ...policyInput,
    request: { category: "list_dir", path: result.path.path },
    signal,
  });
  const combined = explainPolicyResult(
    { ...result, canRemember: false },
    "boundary",
    "consent_scope_narrowed",
    "narrow",
  );
  delete combined.grantScope;
  const facts = new Map(
    [...result.facts, ...listing.facts].map((fact) => [JSON.stringify(fact), fact]),
  );
  combined.facts = [...facts.values()];
  if (listing.decision === "deny") {
    combined.decision = "deny";
    combined.reason = listing.reason;
  } else if (listing.decision === "ask" || result.decision === "ask") {
    combined.decision = "ask";
    combined.reason = listing.decision === "ask" ? listing.reason : result.reason;
  } else if (listing.reason === "yolo" || result.reason === "yolo") combined.reason = "yolo";
  if (listing.risk === "danger") combined.risk = "danger";
  return explainPolicyResult(
    { ...combined, explanation: [...result.explanation, ...listing.explanation] },
    "boundary",
    "search_read_list_consent",
  );
}
