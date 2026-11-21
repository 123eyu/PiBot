import { ApprovalChangedError } from "../../core/approvals.ts";
import type { PreparedTool } from "../../core/local-types.ts";
import { authorizationSnapshot, toolFingerprint } from "../../runtime/tools/local-prepare.ts";
import type { LocalRun } from "../../runtime/tools/local-run.ts";

export interface SearchConsentReceipt {
  previous: string;
  expected: string;
}
export function needsSearchDisclosure(reason: string) {
  return (
    reason === "search_disclosure_required" || reason === "search_provider_disclosure_required"
  );
}
/** Persist inside the allowed approval transaction, before any network operation. */
export function acceptSearch(
  run: LocalRun,
  original: PreparedTool,
  approvedFingerprint: string,
): SearchConsentReceipt {
  const { local, context } = run;
  const search = local.deps.search;
  context.signal.throwIfAborted();
  if (
    !search ||
    !original.searchRecipient ||
    toolFingerprint(original) !== approvedFingerprint ||
    authorizationSnapshot(local, context.botId, context) !== original.authorization
  )
    throw new ApprovalChangedError();
  const previous = search.snapshot();
  const config = search.get();
  const expected = search.disclose(
    original.searchRecipient,
    config?.provider === "searxng" ? config.baseUrl : undefined,
    original.result.reason === "search_disclosure_required",
  );
  return { previous, expected };
}
/** Only this approval's own disclosure update may change its authorization snapshot. */
export async function confirmSearch(
  run: LocalRun,
  original: PreparedTool,
  signal: AbortSignal,
  approvedFingerprint: string,
  receipt: SearchConsentReceipt,
) {
  const search = run.local.deps.search;
  signal.throwIfAborted();
  const current = await run.prepare(original.call, signal, original.searchRecipient);
  const { local, context } = run;
  if (
    search?.snapshot() !== receipt.expected ||
    current.result.decision !== "allow" ||
    toolFingerprint(current, original.authorization) !== approvedFingerprint ||
    authorizationSnapshot(local, context.botId, context, receipt.previous) !==
      original.authorization
  )
    throw new Error("Search authorization changed");
  return current;
}
