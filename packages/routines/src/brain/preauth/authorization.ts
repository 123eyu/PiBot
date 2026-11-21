import type {
  LocalService,
  PreparedTool,
  ToolRunContext,
  UnattendedAuthorization,
} from "@pibot/brain/kit";
import { connectorPreauthIssue, preauthOperation, routineOperationHash } from "@pibot/brain/kit";
import {
  containsPath,
  createPolicyTrace,
  matchesRoutinePreauth,
  pinnedScriptFile,
  preauthInvalidReason,
  recordPolicyStep,
  scriptPinnedScope,
} from "@pibot/policy";
import type { Approval, Routine, RoutinePreauth, RoutineRun } from "@pibot/protocol";
import { RpcError } from "@pibot/protocol";
import { ApprovalsRepo } from "@pibot/storage";
import {
  RoutinePreauthRepo,
  RoutineRunsRepo,
  RoutinesRepo,
  routinePreauthKey,
} from "../../store/index.ts";
import { annotateRoutinePreauth } from "./annotations.ts";
import { withoutTemporaryRoots } from "./temporary-roots.ts";

/** Routines own unattended runs, so they answer the kernel's pre-authorization questions. */
export class RoutineAuthorization implements UnattendedAuthorization {
  constructor(readonly local: LocalService) {}
  private temporaryPaths(routineRunId: string) {
    return this.local.unattended?.temporaryPaths?.(routineRunId) ?? [];
  }
  record(context: ToolRunContext) {
    if (!context.routineRunId) return undefined;
    const r = new RoutineRunsRepo(this.local.deps.db).require(context.routineRunId);
    const identity = this.local.unattended?.identity(r.id);
    if (
      !identity ||
      identity.runId !== context.runId ||
      r.runId !== context.runId ||
      r.botId !== context.botId ||
      r.conversationId !== context.conversationId ||
      !["running", "waiting"].includes(r.status)
    )
      throw new RpcError(-32602, "Routine execution identity changed");
    return r;
  }
  operation(prepared: PreparedTool, isolated: boolean) {
    return preauthOperation(this.local, prepared, isolated);
  }
  match(context: ToolRunContext, prepared: PreparedTool, isolated: boolean) {
    const r = this.record(context),
      op = this.operation(prepared, isolated);
    // Trial consent is learned from the real gate; its editable draft is never authority.
    if (!r?.routineId || r.reason === "trial" || !op || !prepared.boundary) return undefined;
    const routine = new RoutinesRepo(this.local.deps.db).get(r.routineId);
    if (
      !routine ||
      routine.authorizationError ||
      routine.deletedAt ||
      !routine.enabled ||
      routine.botId !== r.botId
    )
      return undefined;
    const boundary = withoutTemporaryRoots(prepared.boundary, this.temporaryPaths(r.id));
    const platform = boundary.location?.platform ?? this.local.deps.platform;
    const wanted =
      op.scope.kind === "workplace"
        ? { ...op, scope: { ...op.scope, root: prepared.result.path?.path ?? op.scope.root } }
        : op.scope.kind === "programs"
          ? { ...op, scope: { ...op.scope, root: prepared.cwd } }
          : op;
    const matched = routine.preauth.find((p) => {
      // Only retain one candidate's small trace; a long preauth list must not inflate cards.
      const trace = createPolicyTrace(prepared.result.explanation);
      const matches =
        !connectorPreauthIssue(this.local, context.botId, p.operation) &&
        !preauthInvalidReason(
          p,
          prepared.settings,
          boundary,
          platform,
          isolated,
          trace,
          prepared.result.explanation.findLast((step) => step.axis === "level")?.source,
        ) &&
        matchesRoutinePreauth(p.operation, wanted, platform, trace) &&
        (p.operation.scope.kind !== "programs" ||
          [
            ...(prepared.result.analysis?.reads ?? []),
            ...(prepared.result.analysis?.writes ?? []),
          ].every(
            (path) =>
              p.operation.scope.kind === "programs" &&
              containsPath(p.operation.scope.root, path, platform),
          ));
      // Only a pending ask is decided by preauthorization; an allow/deny keeps its own chain.
      if (matches && prepared.result.decision === "ask") prepared.result.explanation = trace.steps;
      return matches;
    });
    if (!matched && prepared.result.decision === "ask")
      recordPolicyStep(prepared.result, "grant", "routine_preauth_not_matched", "info");
    return matched;
  }
  remember(context: ToolRunContext, prepared: PreparedTool, approval: Approval, isolated: boolean) {
    const r = this.record(context);
    if (!r) throw new RpcError(-32602, "Routine owner unavailable");
    this.consent(r, prepared, approval, isolated);
  }
  /**
   * "always allow" on a card asked in the middle of a tool step (a Bot browser
   * site or form submission, a download, the file behind open_file). Those cards never park the
   * run, so there is no wait checkpoint; the run must still be this routine's live execution.
   */
  rememberInRun(
    context: ToolRunContext,
    prepared: PreparedTool,
    approval: Approval,
    isolated: boolean,
  ) {
    const r = this.record(context);
    if (!r) throw new RpcError(-32602, "Routine owner unavailable");
    this.consent(r, prepared, approval, isolated, true);
  }
  consent(
    r: RoutineRun,
    prepared: PreparedTool,
    approval: Approval,
    isolated: boolean,
    inRun = false,
  ) {
    const current = new RoutineRunsRepo(this.local.deps.db).require(r.id);
    const op = this.operation(prepared, isolated);
    if (
      !r?.routineId ||
      r.reason === "trial" ||
      !op ||
      !prepared.boundary ||
      !approval.canPreauthorize ||
      approval.status !== "pending" ||
      new ApprovalsRepo(this.local.deps.db).get(approval.id)?.status !== "pending" ||
      approval.routineRunId !== r.id ||
      approval.botId !== r.botId ||
      approval.runId !== r.runId ||
      current.ownerToken !== r.ownerToken ||
      (inRun
        ? !["running", "waiting"].includes(current.status)
        : current.status !== "waiting" ||
          current.waitCheckpoint?.approvalId !== approval.id ||
          JSON.stringify(current.waitCheckpoint) !== JSON.stringify(r.waitCheckpoint))
    )
      throw new RpcError(-32602, "Routine consent unavailable");
    const repo = new RoutinePreauthRepo(this.local.deps.db);
    const boundary = withoutTemporaryRoots(prepared.boundary, this.temporaryPaths(r.id));
    const platform = boundary.location?.platform ?? this.local.deps.platform;
    // An explicit user approval can replace an invalid scope; ordinary form edits cannot.
    const records = repo.list({ routineId: r.routineId }, { limit: 200 });
    const existing = records.find((p) => routinePreauthKey(p.operation) === routinePreauthKey(op));
    if (
      existing &&
      preauthInvalidReason(existing, prepared.settings, boundary, platform, isolated)
    ) {
      repo.revoke(existing.id);
      this.consentAudit(r, "routine.preauth.revoked", existing.id, approval.id);
    }
    // Consent for an earlier text of the same script file in the same folder can never
    // match again (its digest is gone); the person's new consent replaces it.
    for (const old of records)
      if (old.id !== existing?.id && supersededScript(old.operation, op, platform)) {
        repo.revoke(old.id);
        this.consentAudit(r, "routine.preauth.revoked", old.id, approval.id);
      }
    const added = repo.add(r.routineId, op, boundary);
    this.consentAudit(r, "routine.preauth.allowed", added.id, approval.id);
  }
  private consentAudit(
    r: RoutineRun,
    kind: "routine.preauth.allowed" | "routine.preauth.revoked",
    preauthId: string,
    approvalId: string,
  ) {
    this.local.approvals.audit.append({
      botId: r.botId,
      runId: r.runId,
      kind,
      summary: "Routine consent / 例行任务同意",
      detail: {
        ...(r.routineId ? { routineId: r.routineId } : {}),
        routineRunId: r.id,
        preauthId,
        approvalId,
        source: "routine",
        actor: "user",
        reasonCode: "explicit_consent",
      },
    });
  }
  allowed(context: ToolRunContext, prepared: PreparedTool, isolated: boolean) {
    const r = this.record(context),
      op = this.operation(prepared, isolated);
    if (r?.reason === "trial" && r.ownerToken && op && r.allowedOps.length < 200)
      new RoutineRunsRepo(this.local.deps.db).recordAllowed(r.id, r.ownerToken, op);
  }
  resumed(context: ToolRunContext, prepared: PreparedTool, isolated: boolean) {
    if (!context.routineRunId) return undefined;
    const operationHash = routineOperationHash(prepared);
    const held = new RoutineRunsRepo(this.local.deps.db).require(context.routineRunId);
    if (held?.decisionConsumedAt && held.waitCheckpoint?.operationHash === operationHash) {
      const status = new ApprovalsRepo(this.local.deps.db).get(
        held.waitCheckpoint.approvalId,
      )?.status;
      if (status === "denied" || status === "expired") return false;
    }
    const decision = context.routineResume;
    // Fresh tool IDs are allowed; changed targets, risk, recipients or scope are not the old consent.
    if (!decision || operationHash !== decision.operationHash) return undefined;
    if (decision.status !== "allowed") return false;
    if (decision.consumed) return undefined;
    decision.consumed = true;
    const r = this.record(context),
      c = r?.waitCheckpoint;
    if (
      !c ||
      c.operationHash !== decision.operationHash ||
      !r?.decisionConsumedAt ||
      !c.drain ||
      r.attempt <= c.attempt ||
      JSON.stringify(c.workspaceSnapshot) !== JSON.stringify(prepared.boundary) ||
      JSON.stringify(c.permissionSnapshot.effective) !== JSON.stringify(prepared.settings)
    )
      return false;
    if (
      JSON.stringify(c.permissionSnapshot.botOverrides) !==
        JSON.stringify(this.local.permissions.overrides(context.botId)) ||
      c.permissionSnapshot.isolationAvailable !== isolated
    )
      return false;
    return true;
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
    const r = this.record(context);
    if (!r) return;
    this.local.approvals.audit.append({
      botId: r.botId,
      runId: r.runId,
      kind,
      summary: "Allowed by routine preauthorization / 因例行任务预授权放行",
      detail: {
        ...detail,
        routineRunId: r.id,
        ...(r.routineId ? { routineId: r.routineId } : {}),
        source: r.reason === "trial" ? "trial" : "routine",
        actor: "system",
      },
    });
  }
  async annotate(routine: Routine, signal?: AbortSignal): Promise<Routine> {
    const value = await this.annotations(routine.preauth, routine.botId, signal);
    return this.annotated(routine, value);
  }
  private annotated(routine: Routine, preauth: RoutinePreauth[]): Routine {
    return {
      ...routine,
      preauth,
      ...(preauth.some((record) => record.invalidReason === "validation")
        ? { authorizationError: "routine_preauth_reauthorization_required" as const }
        : {}),
    };
  }
  annotations(records: RoutinePreauth[], botId?: string, signal?: AbortSignal) {
    return annotateRoutinePreauth(this.local, records, botId, undefined, signal);
  }
  async annotatePage(routines: Routine[], signal?: AbortSignal): Promise<Routine[]> {
    // Each routine owns its budget and Bot cache; never share permission context across RPCs.
    const bots = new Map(routines.map((routine) => [routine.id, routine.botId]));
    const records = await annotateRoutinePreauth(
      this.local,
      routines.flatMap((routine) => routine.preauth),
      undefined,
      bots,
      signal,
    );
    let offset = 0;
    return routines.map((routine) => {
      const preauth = records.slice(offset, offset + routine.preauth.length);
      offset += routine.preauth.length;
      return this.annotated(routine, preauth);
    });
  }
}

function supersededScript(
  old: RoutinePreauth["operation"],
  next: RoutinePreauth["operation"],
  platform: Parameters<typeof containsPath>[2],
) {
  if (old.scope.kind !== "programs" || next.scope.kind !== "programs") return false;
  const file = pinnedScriptFile(next.scope.programs);
  return (
    old.category === next.category &&
    !!file &&
    scriptPinnedScope(old.scope.programs) &&
    scriptPinnedScope(next.scope.programs) &&
    pinnedScriptFile(old.scope.programs) === file &&
    (old.scope.target ?? "local") === (next.scope.target ?? "local") &&
    containsPath(old.scope.root, next.scope.root, platform) &&
    containsPath(next.scope.root, old.scope.root, platform) &&
    routinePreauthKey(old) !== routinePreauthKey(next)
  );
}
