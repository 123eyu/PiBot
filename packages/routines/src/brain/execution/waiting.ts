import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { readSessionOperation, resolveSessionFile } from "@pibot/agent";
import type { LocalService, PreparedTool, ToolRunContext } from "@pibot/brain/kit";
import {
  prepareTool,
  resolveRunWorkplace,
  routineOperationHash,
  routineWorkplace,
} from "@pibot/brain/kit";
import { RoutineResumeVerificationSchema, RpcError } from "@pibot/protocol";
import {
  ApprovalsRepo,
  ConversationsRepo,
  MessagesRepo,
  RunEventsRepo,
  RunsRepo,
  transaction,
} from "@pibot/storage";
import { RoutineRunsRepo, RoutinesRepo } from "../../store/index.ts";
import type { RoutineLedger } from "../ledger/ledger.ts";
import type { RoutineAuthorization } from "../preauth/authorization.ts";

export function routineWaitingAdapter(
  local: LocalService,
  authorization: RoutineAuthorization,
  ledger: Pick<RoutineLedger, "workplace">,
) {
  const runs = new RoutineRunsRepo(local.deps.db),
    approvals = new ApprovalsRepo(local.deps.db);
  async function inspect(id: string, signal: AbortSignal) {
    const r = runs.require(id),
      c = r.waitCheckpoint;
    if (
      !c?.drain ||
      r.ownerToken ||
      !["waiting", "scheduled"].includes(r.status) ||
      r.decisionConsumedAt
    )
      throw new RpcError(-32602, "Routine is not safely parked");
    const a = approvals.get(c.approvalId);
    const pendingCall = a
      ? new RunEventsRepo(local.deps.db).pendingToolCall(c.runId, c.conversationId, a.toolCallId)
      : undefined;
    const execution = r.runId ? new RunsRepo(local.deps.db).get(r.runId) : undefined,
      message = new MessagesRepo(local.deps.db).get(c.messageId),
      conversation = new ConversationsRepo(local.deps.db).get(c.conversationId);
    const attempt = Number(
      basename(c.sessionFile)
        .replace(`routine-${r.id}-`, "")
        .replace(/\.jsonl$/, ""),
    );
    if (
      !a ||
      !pendingCall ||
      a.routineRunId !== r.id ||
      a.runId !== r.runId ||
      a.botId !== r.botId ||
      a.messageId !== c.messageId ||
      execution?.messageId !== c.messageId ||
      execution.sessionFile !== c.sessionFile ||
      message?.runId !== r.runId ||
      message.botId !== r.botId ||
      message.conversationId !== c.conversationId ||
      conversation?.botId !== r.botId ||
      (conversation.routineId ?? null) !== r.routineId ||
      c.botId !== r.botId ||
      c.runId !== r.runId ||
      c.routineRunId !== r.id ||
      c.sessionFile !== r.sessionFile ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > c.attempt ||
      basename(c.sessionFile) !== `routine-${r.id}-${attempt}.jsonl`
    )
      throw new RpcError(-32602, "Routine checkpoint identity changed");
    const draft = r.routineId ? new RoutinesRepo(local.deps.db).require(r.routineId) : r.trialDraft;
    if (
      !draft ||
      ("deletedAt" in draft && (draft.deletedAt || !draft.enabled)) ||
      draft.botId !== r.botId
    )
      throw new RpcError(-32602, "Routine unavailable");
    const call = await readSessionOperation({
      sessionDir: join(local.deps.dataDir, "bots", r.botId, "sessions"),
      sessionFile: resolveSessionFile(local.deps.dataDir, c.sessionFile),
      toolCallId: a.toolCallId,
      signal,
    });
    if (call.tool !== pendingCall.tool)
      throw new RpcError(-32602, "Routine event and model context disagree");
    // The previous period's folder the run received read-only.
    const previousPeriod = local.unattended?.temporaryPaths?.(r.id) ?? [];
    const context: ToolRunContext = {
      routineRunId: r.id,
      botId: r.botId,
      runId: c.runId,
      messageId: c.messageId,
      conversationId: c.conversationId,
      signal,
      language: "zh",
      routineWorkplace: {
        ...ledger.workplace(r.id, routineWorkplace(local, r.botId, draft)),
        temporaryRoots:
          r.reason === "trial"
            ? c.workspaceSnapshot.roots
                .filter((root) =>
                  r.trialDraft?.triggers.some((t) => t.kind === "folder" && t.path === root.path),
                )
                .map(({ id, path }) => ({ id, path }))
            : c.workspaceSnapshot.roots
                .filter((root) => root.role === "readonly" && previousPeriod.includes(root.path))
                .map(({ id, path }) => ({ id, path })),
      },
    };
    const delivery = a.draft
      ? local.drafts.verifyCheckpoint(r.id, c.operationHash, call)
      : undefined;
    const settledDraft =
      delivery && delivery.view.status !== "pending" && delivery.view.status !== "sending";
    const prepared: PreparedTool | undefined = settledDraft
      ? undefined
      : await prepareTool(local, context, call, signal);
    const boundary =
      prepared?.boundary ?? (await resolveRunWorkplace(local, context, signal)).boundary;
    const isolation =
      call.tool === "run_command"
        ? await local.target.isolationStatus(signal)
        : { available: true };
    const botOverrides = local.permissions.overrides(r.botId),
      effective = local.permissions.effective(r.botId);
    const permissionSnapshot = {
      // The saved global value is historical metadata; effective settings determine live authority.
      global: c.permissionSnapshot.global,
      botOverrides,
      effective,
      isolationAvailable: isolation.available,
    };
    const permissionRevision = Number.parseInt(
      createHash("sha256")
        .update(JSON.stringify([effective, botOverrides]))
        .digest("hex")
        .slice(0, 12),
      16,
    );
    signal.throwIfAborted();
    // The checkpoint digest includes the original normalized authorization facts, not just arguments.
    if (
      (prepared && routineOperationHash(prepared) !== c.operationHash) ||
      JSON.stringify(boundary) !== JSON.stringify(c.workspaceSnapshot) ||
      JSON.stringify(permissionSnapshot) !== JSON.stringify(c.permissionSnapshot) ||
      permissionRevision !== c.permissionRevision ||
      JSON.stringify(runs.require(id).waitCheckpoint) !== JSON.stringify(c)
    )
      throw new RpcError(-32602, "Routine resume authorization changed");
    return {
      r,
      c,
      a,
      prepared,
      isolation,
      verification: RoutineResumeVerificationSchema.strip().parse({
        ...c,
        managedSessionVerified: true,
      }),
    };
  }
  return {
    async verify(id: string, signal: AbortSignal) {
      return (await inspect(id, signal)).verification;
    },
    async resolve(
      approvalId: string,
      decision: "allow" | "deny",
      signal: AbortSignal,
      preauthorize = false,
    ) {
      const approval = approvals.get(approvalId);
      if (!approval?.routineRunId || approval.status !== "pending")
        throw new RpcError(-32602, "Approval is no longer pending");
      const { r, a, prepared, isolation } = await inspect(approval.routineRunId, signal);
      if (a.id !== approvalId || approvals.get(a.id)?.status !== "pending")
        throw new RpcError(-32602, "Approval changed");
      if (a.draft || !prepared) throw new RpcError(-32602, "Send drafts require drafts.resolve");
      const expired = Date.parse(a.expiresAt) <= Date.now();
      const status = expired
        ? "expired"
        : decision === "allow" && prepared.result.decision !== "deny"
          ? "allowed"
          : "denied";
      if (
        preauthorize &&
        (status !== "allowed" ||
          !a.canPreauthorize ||
          !local.unattendedAuthorization.operation(prepared, isolation.available))
      )
        throw new RpcError(-32602, "Routine cannot be preauthorized");
      transaction(local.deps.db, () => {
        if (preauthorize) authorization.consent(r, prepared, a, isolation.available);
        if (
          !approvals.resolve(a.id, status, false, [
            ...prepared.result.explanation,
            {
              axis: "grant",
              code: expired
                ? "approval_expired"
                : status === "allowed"
                  ? "approval_user_allowed"
                  : "approval_user_denied",
              effect: status === "allowed" ? "allow" : "deny",
            },
          ])
        )
          throw new RpcError(-32602, "Approval changed");
        local.approvals.audit.append({
          botId: r.botId,
          runId: r.runId,
          kind: "approval.resolved",
          summary: `Routine approval ${status}`,
          detail: {
            approvalId: a.id,
            policySteps: (approvals.get(a.id)?.explanation ?? []).map((step) => step.code),
            routineRunId: r.id,
            ...(r.routineId ? { routineId: r.routineId } : {}),
            toolCallId: a.toolCallId,
            category: a.category,
            source: a.source,
            actor: expired ? "automatic" : "user",
            status,
            decision: status === "allowed" ? "allow" : "deny",
            remember: false,
          },
        });
      });
      local.deps.peer.emit("approval.resolved", { id: a.id, status, remembered: false });
      local.deps.peer.emit("inbox.changed", {});
      local.deps.peer.emit("routines.changed", r.routineId ? { id: r.routineId } : {});
    },
  };
}
