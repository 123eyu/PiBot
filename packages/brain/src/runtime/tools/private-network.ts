import { mustAskNow, type PolicyResult } from "@pibot/policy";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

/**
 * Maintainers 2026-11-14: a person answered a card that named local-network targets (browser origins
 * or command hosts); they stay reachable for the rest of this run. Only must-ask cards count:
 * YOLO, grants and routine consent never answer those, so "allowed" here is the person's answer.
 * `current` is the call re-prepared after the answer; it must still be that card.
 */
export function openPrivateTargets(
  local: LocalService,
  context: Pick<ToolRunContext, "runId">,
  original: PolicyResult,
  current: PolicyResult,
) {
  if (!original.privateTargets?.length || !mustAskNow(original) || !mustAskNow(current)) return;
  local.privateNetwork.approve(context.runId, original.privateTargets);
}
