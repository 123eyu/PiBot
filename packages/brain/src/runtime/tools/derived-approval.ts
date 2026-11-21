import type { LocalToolCall } from "@pibot/agent";
import type { PolicyResult } from "@pibot/policy";
import { explainPolicyResult } from "@pibot/policy";
import type { PreparedTool } from "../../core/local-types.ts";
import { allowedByYolo } from "../../core/yolo.ts";
import { approvedUnchanged, toolFingerprint } from "./local-prepare.ts";
import type { LocalRun } from "./local-run.ts";
import { openPrivateTargets } from "./private-network.ts";
import { blockedReason } from "./tools.ts";

const notApplicable = { available: true, reason: "command_isolation_not_applicable" };

/**
 * Asks the user about an operation derived from an already authorized tool call (the command
 * behind open_app, a site the Bot browser was refused, a form submission). The derived call
 * keeps the original tool call id so the card and audit belong to that step. `adjust` lets the
 * caller narrow the policy result (always ask, never remember); a changed result denies.
 * Returns the prepared operation, or the refusal text for the model.
 */
export async function approveDerived(
  run: LocalRun,
  call: LocalToolCall,
  signal: AbortSignal,
  options: {
    adjust?(result: PolicyResult): PolicyResult;
    isolation?: { available: boolean; reason?: string };
    /** Shown on the card instead of `call` (e.g. a form submission judged as a site visit). */
    display?: LocalToolCall;
    /** `call` is a browser_open judged as submitting a form there. */
    submit?: boolean;
    /** Temporary reads judge policy before touching the browser lease. */
    deferBrowserLease?: boolean;
    /** Capture the exact receipt before yielding back, including a routine grant that may expire. */
    onApproved?(prepared: PreparedTool, preauthId?: string): void;
  } = {},
): Promise<PreparedTool | string> {
  const { local, context } = run;
  const adjust = options.adjust ?? ((result: PolicyResult) => result);
  const isolation = options.isolation ?? notApplicable;
  return local.approvals.serial(
    context.routineRunId ? context.runId : context.botId,
    signal,
    async () => {
      const prepare = async () => {
        const prepared = await run.prepare(call, signal, undefined, {
          submit: options.submit,
          deferBrowserLease: options.deferBrowserLease,
        });
        prepared.result = adjust(prepared.result);
        return prepared;
      };
      const prepared = await prepare();
      if (prepared.result.decision === "deny") return blockedReason(prepared.result.reason);
      if (prepared.result.decision === "allow") {
        if (allowedByYolo(prepared.result)) run.markYolo(call, prepared.result);
        options.onApproved?.(prepared);
        return prepared;
      }
      const preauth = local.unattendedAuthorization.match(context, prepared, isolation.available);
      if (preauth) {
        local.unattendedAuthorization.audit(context, "routine.preauth.allowed", {
          preauthId: preauth.id,
          reasonCode: "routine_preauth",
          policySteps: [...prepared.result.explanation.map((step) => step.code), "routine_preauth"],
        });
        options.onApproved?.(prepared, preauth.id);
        return prepared;
      }
      const approved = toolFingerprint(prepared);
      const status = await local.approvals.request(
        { ...context, signal },
        options.display ?? call,
        prepared.result,
        isolation,
        async () => {
          const current = await prepare();
          return toolFingerprint(current) === approved
            ? current.result
            : explainPolicyResult(
                { ...current.result, decision: "deny", reason: "changed", canRemember: false },
                "boundary",
                "changed",
              );
        },
        undefined,
        undefined,
        // In a scheduled run "always allow" preauthorizes this routine for the scope.
        {
          available:
            !!context.routineRunId &&
            context.routineSource === "routine" &&
            !!local.unattendedAuthorization.operation(prepared, isolation.available),
          allow: (approval) =>
            local.unattendedAuthorization.rememberInRun(
              context,
              prepared,
              approval,
              isolation.available,
            ),
        },
      );
      if (status !== "allowed")
        return status === "cancelled"
          ? "已停止 / Stopped"
          : status === "expired" || status === "auto_denied"
            ? "用户未响应，请换办法，不要重复请求 / The user did not respond; use another approach rather than repeating the request"
            : "用户拒绝，请换办法，不要重复请求 / The user denied permission; use another approach rather than repeating the request";
      const current = await prepare();
      if (current.result.decision === "deny" || !approvedUnchanged(current, prepared, approved))
        return blockedReason("changed");
      openPrivateTargets(local, context, prepared.result, current.result);
      options.onApproved?.(current);
      return current;
    },
    run.timing(call.id),
  );
}
