import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { ToolRunContext } from "@pibot/brain/kit";
import { businessConfirmation } from "@pibot/brain/kit";
import { type Routine, RoutineDraftSchema, type RoutineProposal, RpcError } from "@pibot/protocol";
import { AuditRepo, transaction } from "@pibot/storage";
import { routinePreauthKey } from "../../store/index.ts";
import { validateNewOnce } from "../schedule/once.ts";
import { prepareAssociations } from "../triggers/associations.ts";
import { validateRoutine } from "../validation/validation.ts";
import type { RoutineProposalService } from "./service.ts";

const MINIMAL_EXAMPLE =
  'Minimal routine_propose / 最小写法: {"name":"每日磁盘检查","instructions":"what to do / 要做什么","triggers":[{"kind":"cron","expr":"0 9 * * *"}]}';

/**
 * One reason line per cause. "Missing task details or invalid authorization" alone sent a model
 * through 20+ guesses at field names (Windows, 2026-11-04) when only instructions/triggers were
 * missing. Field names and preauth operation kinds only; never the user's text.
 */
function incompleteText(payload: RoutineProposal["payload"]) {
  const parts: string[] = [];
  if (payload.missingFields.length)
    parts.push(
      `缺少字段：${payload.missingFields.join("、")}。已经知道的按字段名填上；不知道的（比如每天几点运行）用 ask_user 问用户，不要猜 / Missing fields: ${payload.missingFields.join(", ")}. Fill in what you already know under these names; ask the user with ask_user for what you do not know (such as the time of day), never guess`,
    );
  if (payload.questions?.length)
    parts.push(
      `有 ${payload.questions.length} 个问题要用户决定，YOLO 不能代答，请先问用户 / ${payload.questions.length} question(s) need the user's choice; YOLO cannot answer them, ask the user`,
    );
  if (payload.blockedPreauth.length) {
    const reasons = [...new Set(payload.blockedPreauth.map((item) => item.reason))].join(", ");
    parts.push(
      `${payload.blockedPreauth.length} 项预授权超出当前权限或范围无效（${reasons}），去掉 preauth 或请用户在设置里调整 / ${payload.blockedPreauth.length} preauthorization(s) exceed the current permissions or have an invalid scope (${reasons}); drop preauth or ask the user to adjust settings`,
    );
  }
  return `未创建任务，也没有确认卡 / Not created, no confirmation card. ${parts.join("；")}\n${MINIMAL_EXAMPLE}`;
}

/** Runs inside the tool, so it must never cancel its own queue or enqueue a fake user reply. */
export async function saveYoloRoutine(
  owner: RoutineProposalService,
  context: ToolRunContext,
  call: LocalToolCall,
  old: Routine | undefined,
  payload: RoutineProposal["payload"],
  signal: AbortSignal,
): Promise<LocalToolResult> {
  const local = owner.s.deps.local;
  const automatic = businessConfirmation(local, context, call);
  if (!automatic) throw new RpcError(-32602, "business_confirmation_changed");
  if (payload.missingFields.length || payload.questions?.length || payload.blockedPreauth.length)
    return { isError: true, text: incompleteText(payload) };
  const base = old && {
    botId: old.botId,
    name: old.name,
    instructions: old.instructions,
    triggers: old.triggers.map((t) => t.config),
    workplace: old.workplace,
    preauth: old.preauth.filter((p) => !p.revokedAt).map((p) => p.operation),
    notify: old.notify,
    maxDurationMin: old.maxDurationMin,
    carryLastResult: old.carryLastResult,
    output: old.output,
    missedPolicy: old.missedPolicy,
    enabled: old.enabled,
  };
  const parsed = RoutineDraftSchema.safeParse({ ...base, ...payload.draft, botId: context.botId });
  if (!parsed.success) {
    // Field paths only, never values: the draft carries the user's instructions.
    const paths = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
    ].slice(0, 8);
    return {
      isError: true,
      text: `任务字段不完整，请补充后重试：${paths.join("、")} / Incomplete routine fields; provide and retry: ${paths.join(", ")}\n${MINIMAL_EXAMPLE}`,
    };
  }
  const action = async () => {
    automatic.assertCurrent();
    const retained = new Set(
      old?.preauth.filter((p) => !p.revokedAt).map((p) => routinePreauthKey(p.operation)) ?? [],
    );
    if (parsed.data.preauth.some((p) => !retained.has(routinePreauthKey(p))))
      throw new RpcError(-32602, "routine_preauth_requires_explicit_settings");
    const permissionSnapshot = JSON.stringify(local.permissions.effective(context.botId));
    const places = local.workplaces.repo.list(context.botId);
    const allowedPaths = new Set([places.home, ...places.folders.map((f) => f.path)]);
    if (parsed.data.triggers.some((t) => t.kind === "folder" && !allowedPaths.has(t.path)))
      throw new RpcError(-32602, "routine_monitor_requires_registered_folder");
    const draft = await validateRoutine(
      local,
      parsed.data,
      owner.s.timing.cronMinIntervalMs,
      signal,
      retained,
      owner.s.deps.agent,
    );
    const captured = await prepareAssociations(local, draft, signal, retained);
    if (old) await owner.s.execution.cancelRoutine(old.id, undefined, signal);
    const currentBoundary = await prepareAssociations(local, draft, signal, retained);
    signal.throwIfAborted();
    const result = transaction(owner.s.deps.db, () => {
      automatic.assertCurrent();
      owner.source(context);
      if (
        JSON.stringify(local.permissions.effective(context.botId)) !== permissionSnapshot ||
        JSON.stringify(local.workplaces.repo.list(context.botId)) !== JSON.stringify(places) ||
        JSON.stringify(captured) !== JSON.stringify(currentBoundary)
      )
        throw new RpcError(-32602, "routine_proposal_permission_changed");
      if (old && owner.s.require(old.id).version !== old.version)
        throw new RpcError(-32602, "routine_proposal_unavailable");
      validateNewOnce(draft, old);
      const proposal = owner.repo.create({
        botId: context.botId,
        messageId: context.messageId,
        dedupeKey: `routine-proposal:${context.runId}:${call.id}`,
        payload,
      });
      const saved = owner.repo.resolve(proposal.id, true, draft, captured);
      automatic.audit();
      new AuditRepo(owner.s.deps.db, owner.s.deps.redactor).append({
        botId: context.botId,
        runId: context.runId,
        kind: "routine.proposal.resolved",
        summary: "Routine saved by YOLO / YOLO 已保存调度任务",
        detail: {
          actor: "automatic",
          reasonCode: "yolo",
          toolCallId: call.id,
          conversationId: context.conversationId,
          routineId: saved.routine?.id,
        },
      });
      return saved;
    });
    if (old && result.routine) owner.s.resumedOnce(old, result.routine);
    owner.changed(result.proposal);
    owner.s.changed(result.routine?.id);
    await owner.s.syncWatchers();
    return {
      text: JSON.stringify({
        saved: true,
        routineId: result.routine?.id,
        enabled: result.routine?.enabled,
      }),
      summary: context.language === "zh" ? "调度任务已保存（YOLO）" : "Routine saved (YOLO)",
    };
  };
  return old ? owner.s.withMutation(old.id, action) : action();
}
