import type { Approval } from "@pibot/protocol-base";
import { RpcError } from "@pibot/protocol-base";
import type { UnattendedAuthorization } from "../../core/capability.ts";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { connectionAsksNow, preauthOperation } from "./operation.ts";

/**
 * The kernel's side of unattended-run pre-authorization. The data and matching belong to the
 * capability that owns unattended runs; this facade asks it and fails closed without one: a
 * context that claims an unattended run but has no owner never matches, never resumes, and
 * cannot record consent.
 */
export class UnattendedAuthorizationPort implements UnattendedAuthorization {
  constructor(private readonly local: LocalService) {}
  private owner(context: ToolRunContext) {
    if (!context.routineRunId) return undefined;
    const owner = this.local.unattended;
    if (!owner) throw new RpcError(-32602, "Routine owner unavailable");
    return owner.authorization;
  }
  /** Pure policy: what a pre-authorization could cover, independent of any run. */
  operation(prepared: PreparedTool, isolated: boolean) {
    return preauthOperation(this.local, prepared, isolated);
  }
  record(context: ToolRunContext) {
    return this.owner(context)?.record(context);
  }
  match(context: ToolRunContext, prepared: PreparedTool, isolated: boolean) {
    // The same must-ask decision as `operation`, so a record saved before the mode changed
    // cannot answer for it either.
    if (!context.routineRunId || !this.local.unattended || connectionAsksNow(prepared))
      return undefined;
    return this.local.unattended.authorization.match(context, prepared, isolated);
  }
  remember(context: ToolRunContext, prepared: PreparedTool, approval: Approval, isolated: boolean) {
    const owner = this.owner(context);
    if (!owner) throw new RpcError(-32602, "Routine owner unavailable");
    owner.remember(context, prepared, approval, isolated);
  }
  rememberInRun(
    context: ToolRunContext,
    prepared: PreparedTool,
    approval: Approval,
    isolated: boolean,
  ) {
    const owner = this.owner(context);
    if (!owner) throw new RpcError(-32602, "Routine owner unavailable");
    owner.rememberInRun(context, prepared, approval, isolated);
  }
  allowed(context: ToolRunContext, prepared: PreparedTool, isolated: boolean) {
    if (!context.routineRunId || !this.local.unattended) return;
    this.local.unattended.authorization.allowed(context, prepared, isolated);
  }
  resumed(context: ToolRunContext, prepared: PreparedTool, isolated: boolean) {
    if (!context.routineRunId) return undefined;
    // Without the owner a parked decision cannot be verified, so it is never honoured.
    if (!this.local.unattended) return false;
    return this.local.unattended.authorization.resumed(context, prepared, isolated);
  }
  audit(
    context: ToolRunContext,
    kind: "routine.preauth.allowed",
    detail: {
      preauthId?: string;
      approvalId?: string;
      reasonCode?: string;
      policySteps?: string[];
    } = {},
  ) {
    if (!context.routineRunId || !this.local.unattended) return;
    this.local.unattended.authorization.audit(context, kind, detail);
  }
}
