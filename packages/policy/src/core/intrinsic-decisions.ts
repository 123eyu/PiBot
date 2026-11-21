import { privateNetworkHost } from "../targets/private-network.ts";
import { PRIVATE_NETWORK_REASON } from "./confirmation-reasons.ts";
import type { PolicyTrace } from "./explain.ts";
import type { EvaluationInput, PolicyResult } from "./types.ts";

/**
 * Categories decided from the request alone: proposing something, a note about a change, the
 * paired phone's own switch, the Bot's own commands and browser tabs. None of them reaches a
 * file, a command or a network, so they are settled before any path is resolved and never add a
 * permission level, grant or confirmation.
 */
export function intrinsicDecision(
  // Only the request: the portable phone entry has no filesystem, grants or settings.
  input: Pick<EvaluationInput, "request">,
  trace: PolicyTrace,
): PolicyResult | undefined {
  // These reads reach only the run's visible DB notes, whose owner/scope the memory service
  // checks. Decide before filesystem facts reject categories without a path.
  if (input.request.category === "memory_read")
    return trace.result(
      {
        decision: "allow",
        reason: "own_memory_read",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // Maintainers 2026-11-14: reading the computer's own interfaces, routes, neighbours, Wi-Fi and DNS
  // is fixed read-only programs Pi Bot runs itself; it reaches no other host and changes nothing.
  if (input.request.category === "local_network" && input.request.operation === "info")
    return trace.result(
      {
        decision: "allow",
        reason: "network_state_read",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // Pinging reaches another device: only one on the local network, asked each time per host
  // and task (PRIVATE_NETWORK_REASON, never remembered or answered by YOLO / routines).
  if (input.request.category === "local_network") {
    const host = privateNetworkHost(input.request.host);
    const result: Omit<PolicyResult, "explanation"> = {
      decision: "deny",
      reason: "private_network_only",
      risk: "normal",
      facts: [],
      canRemember: false,
    };
    if (!host) return trace.result(result, "boundary");
    result.facts.push({ kind: "network", value: host });
    result.privateTargets = [host];
    result.decision = input.request.approved.includes(host) ? "allow" : "ask";
    result.reason =
      result.decision === "allow" ? "private_network_run_approved" : PRIVATE_NETWORK_REASON;
    return trace.result(result, "boundary");
  }
  // The installer independently binds role, folder and host selection; this grants no plugin-tool authority.
  if (input.request.category === "plugin_install")
    return trace.result(
      {
        decision: "allow",
        reason: "plugin_install",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  if (input.request.category === "tool_discovery")
    return trace.result(
      {
        decision: "allow",
        reason: "scoped_tool_metadata",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // Bot-owned DB memory is intrinsic, not a filesystem permission or reusable grant.
  // The business layer enforces ownership/quota and routes ask mode to an indefinite proposal.
  // Intrinsic proposal creation grants no execution authority; acceptance is a user RPC.
  if (input.request.category === "routine_proposal")
    return trace.result(
      {
        decision: "allow",
        reason:
          input.request.operation === "query"
            ? "bot_routines_readonly"
            : "user_confirmation_required",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // Listing runners reads names and online state only; a move proposal only creates a card,
  // and moving the topic is the user's own RPC (never YOLO, a grant or a routine preauthorization).
  if (input.request.category === "workplace_proposal")
    return trace.result(
      {
        decision: "allow",
        reason:
          input.request.operation === "list"
            ? "execution_targets_readonly"
            : "user_confirmation_required",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // A skill proposal only creates a confirmation card; saving it is a separate user RPC.
  if (input.request.category === "skill_proposal")
    return trace.result(
      {
        decision: "allow",
        reason: "user_confirmation_required",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // Proposing check commands only creates a card; the user saves them, and running
  // them later is an ordinary run_command decision.
  if (input.request.category === "check_proposal")
    return trace.result(
      {
        decision: "allow",
        reason: "user_confirmation_required",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  if (input.request.category === "collaboration")
    return trace.result(
      {
        decision: "allow",
        reason: "validated_group_collaboration",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // A review finding is a note shown in the changes sidebar: no file, command or network access,
  // so it is read-only from the user's point of view and never needs approval.
  if (input.request.category === "review" || input.request.category === "planning")
    return trace.result(
      {
        decision: "allow",
        reason:
          input.request.category === "planning" ? "planning_metadata" : "review_note_readonly",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // The paired phone's owner decides on the phone (a switch per category, a system
  // consent sheet for each SMS); the phone refuses whatever is off, so nothing is asked here.
  if (input.request.category === "phone_data")
    return trace.result(
      {
        decision: "allow",
        reason: "phone_owner_switch",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  // Listing or closing the Bot browser's own tabs reaches no site and reads no page.
  if (input.request.category === "browser_tabs")
    return trace.result(
      {
        decision: "allow",
        reason: "own_browser_tabs",
        risk: "normal",
        facts: [],
        canRemember: false,
      },
      "intrinsic",
    );
  return undefined;
}
