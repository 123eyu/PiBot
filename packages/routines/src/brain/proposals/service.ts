import type { LocalToolCall } from "@pibot/agent";
import type { CapabilityContext, ChatService, ToolRunContext } from "@pibot/brain/kit";
import { redactValue, runYolo } from "@pibot/brain/kit";
import {
  CanonicalTimeSchema,
  type MethodParams,
  OnceTimeInputSchema,
  type RoutineDraft,
  RoutineDraftSchema,
  RoutinePartialDraftSchema,
  type RoutineProposal,
  RoutineProposeInputSchema,
  RpcError,
  TimezoneSchema,
} from "@pibot/protocol";
import { resolveOnceTime } from "@pibot/scheduler";
import { AuditRepo, BotsRepo, MessagesRepo, transaction } from "@pibot/storage";
import { RoutineProposalsRepo } from "../../store/index.ts";
import type { RoutineService } from "../service.ts";
import { validateRoutineTriggers } from "../validation/validation.ts";
import { queryRoutines } from "../views/query.ts";
import { acceptRoutineProposal } from "./accept.ts";
import { proposalPreauthIssue, proposedBoundary } from "./validation.ts";
import { saveYoloRoutine } from "./yolo.ts";

export class RoutineProposalService {
  readonly repo: RoutineProposalsRepo;
  constructor(
    readonly s: RoutineService,
    private readonly chat: ChatService,
    readonly confirmGroupNotice: CapabilityContext["groups"]["confirmNotice"],
  ) {
    this.repo = new RoutineProposalsRepo(s.deps.db);
  }
  refresh() {
    const expired = transaction(this.s.deps.db, () => {
      const items = this.repo.expireStale();
      for (const p of items) this.audit(p);
      return items;
    });
    for (const p of expired) this.changed(p);
  }
  list(query: MethodParams["routines.proposals"]) {
    this.refresh();
    if (query.id) {
      const p = this.repo.get(query.id);
      return p &&
        (!query.botId || p.botId === query.botId) &&
        (!query.messageId || p.messageId === query.messageId)
        ? [p]
        : [];
    }
    const { botId, messageId, ...page } = query;
    return this.repo.list({ botId, messageId }, page);
  }
  active(botId: string) {
    const bot = new BotsRepo(this.s.deps.db).get(botId);
    if (!bot || bot.archivedAt) throw new RpcError(-32602, "routine_proposal_unavailable");
    return bot;
  }
  changed(p: RoutineProposal) {
    this.s.deps.peer.emit("routines.changed", {
      botId: p.botId,
      proposalId: p.id,
      ...(p.messageId ? { messageId: p.messageId } : {}),
      ...(p.payload.routineId ? { id: p.payload.routineId } : {}),
    });
    this.s.deps.peer.emit("inbox.changed", {});
  }
  audit(p: RoutineProposal, context?: ToolRunContext) {
    new AuditRepo(this.s.deps.db, this.s.deps.redactor).append({
      botId: p.botId,
      ...(context ? { runId: context.runId } : {}),
      kind: context ? "routine.proposed" : "routine.proposal.resolved",
      summary: context
        ? "Routine proposed / 已提出例行任务"
        : "Routine proposal resolved / 例行提案已处理",
      detail: {
        source: "chat",
        reason: context ? "proposed" : p.status,
        actor: context ? "automatic" : p.status === "expired" ? "system" : "user",
        ...(p.payload.routineId ? { routineId: p.payload.routineId } : {}),
      },
    });
  }
  source(context: ToolRunContext) {
    this.active(context.botId);
    const message = new MessagesRepo(this.s.deps.db).get(context.messageId);
    if (
      message?.botId !== context.botId ||
      message.runId !== context.runId ||
      message.role !== "assistant" ||
      message.status !== "streaming"
    )
      throw new RpcError(-32602, "routine_proposal_unavailable");
  }
  query(context: ToolRunContext, call: LocalToolCall, signal: AbortSignal) {
    return queryRoutines(this, context, call, signal);
  }
  async propose(context: ToolRunContext, call: LocalToolCall, signal: AbortSignal) {
    const stop = AbortSignal.any([signal, this.s.signal()]);
    this.source(context);
    const input = RoutineProposeInputSchema.parse(redactValue(call.input, this.s.deps.redactor));
    const { routineId, missingFields = [], ...fields } = input;
    const old = routineId ? this.s.require(routineId) : undefined;
    if (old && old.botId !== context.botId)
      throw new RpcError(-32602, "routine_proposal_unavailable");
    const { triggers, ...patch } = fields;
    const normalized: RoutineDraft["triggers"] = [];
    const timeQuestions: string[] = [];
    let onceRequest: import("@pibot/protocol").OnceTimeInput | undefined;
    for (const t of triggers ?? []) {
      const timezone =
        t.kind === "folder"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : (t.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (t.kind !== "once") {
        normalized.push(t.kind === "cron" ? { ...t, timezone: timezone } : t);
        continue;
      }
      let at: string | undefined;
      if (t.localTime) {
        try {
          const result = resolveOnceTime(
            {
              localTime: t.localTime,
              timezone: timezone,
              ...(t.disambiguation ? { disambiguation: t.disambiguation } : {}),
            },
            stop,
          );
          if (result.at && (!t.at || t.at === result.at)) at = result.at;
        } catch {
          stop.throwIfAborted();
        }
      } else if (t.at && CanonicalTimeSchema.safeParse(t.at).success) at = t.at;
      if (
        at &&
        TimezoneSchema.safeParse(timezone).success &&
        (Date.parse(at) > Date.now() ||
          old?.triggers.some((v) => v.config.kind === "once" && v.config.at === at))
      )
        normalized.push({ kind: "once", at, timezone: timezone });
      else {
        missingFields.push("triggers");
        const request = OnceTimeInputSchema.safeParse({ localTime: t.localTime, timezone });
        if (request.success) onceRequest = request.data;
        timeQuestions.push(
          `请确认单次日期、时区和重复时间候选 / Confirm once date, timezone and repeated-time candidate: ${t.localTime ?? t.at ?? "?"} (${timezone})`,
        );
      }
    }
    const draft = RoutinePartialDraftSchema.parse({
      ...patch,
      botId: context.botId,
      ...(triggers && !timeQuestions.length ? { triggers: normalized } : {}),
    });
    if (draft.triggers) {
      draft.triggers = [...new Map(draft.triggers.map((t) => [JSON.stringify(t), t])).values()];
      await validateRoutineTriggers(
        this.s.deps.local,
        draft.triggers,
        this.s.timing.cronMinIntervalMs,
        stop,
      );
    }
    const boundary = await proposedBoundary(
      this.s.deps.local,
      { ...draft, botId: context.botId },
      stop,
    );
    const blockedPreauth: RoutineProposal["payload"]["blockedPreauth"] = [];
    const preauth: RoutineDraft["preauth"] = [];
    const candidates = new Map((draft.preauth ?? []).map((op) => [JSON.stringify(op), op]));
    for (const operation of candidates.values()) {
      const reason = await proposalPreauthIssue(
        this.s.deps.local,
        context.botId,
        operation,
        boundary,
        stop,
      );
      if (reason) blockedPreauth.push({ operation, reason });
      else preauth.push(operation);
    }
    stop.throwIfAborted();
    this.active(context.botId);
    const missing = new Set(missingFields);
    if (!old)
      for (const key of ["name", "instructions", "triggers"] as const)
        if (!draft[key]) missing.add(key);
    if (runYolo(this.s.deps.local, context))
      return saveYoloRoutine(
        this,
        context,
        call,
        old,
        {
          ...(routineId ? { routineId, expectedVersion: old?.version } : {}),
          draft: { ...draft, ...(draft.preauth ? { preauth } : {}) },
          missingFields: [...missing],
          blockedPreauth,
          ...(timeQuestions.length ? { questions: timeQuestions.slice(0, 20) } : {}),
          ...(onceRequest ? { onceRequest } : {}),
        },
        stop,
      );
    const proposal = transaction(this.s.deps.db, () => {
      const result = this.repo.create({
        botId: context.botId,
        messageId: context.messageId,
        dedupeKey: `routine-proposal:${context.runId}:${call.id}`,
        payload: {
          ...(routineId ? { routineId, expectedVersion: old?.version } : {}),
          draft: { ...draft, ...(draft.preauth ? { preauth } : {}) },
          missingFields: [...missing],
          blockedPreauth,
          ...(timeQuestions.length ? { questions: timeQuestions.slice(0, 20) } : {}),
          ...(onceRequest ? { onceRequest } : {}),
        },
      });
      this.audit(result, context);
      return result;
    });
    this.changed(proposal);
    this.s.deps.local.yolo.onRunEnabled(context, async () => {
      if (this.repo.get(proposal.id)?.status !== "open") return;
      const result = await saveYoloRoutine(this, context, call, old, proposal.payload, stop);
      if (result.isError && runYolo(this.s.deps.local, context)) {
        transaction(this.s.deps.db, () => {
          this.repo.expire(proposal.id);
          new AuditRepo(this.s.deps.db, this.s.deps.redactor).append({
            botId: context.botId,
            runId: context.runId,
            kind: "routine.proposal.resolved",
            summary: "Routine requires missing details / 调度任务仍缺少信息",
            detail: {
              actor: "automatic",
              reasonCode: "yolo_missing_precondition",
              toolCallId: call.id,
            },
          });
        });
        this.changed(this.repo.require(proposal.id));
      }
    });
    return {
      text:
        context.language === "zh"
          ? "已向用户提出，等用户在确认卡确认。尚未创建任务或授予权限。"
          : "Proposed to the user; await their confirmation card. No task or permission has been created.",
      summary:
        context.language === "zh"
          ? "例行任务提议：等待用户确认"
          : "Routine proposal: awaiting user confirmation",
    };
  }
  async resolve(params: MethodParams["routines.proposal.resolve"]) {
    this.refresh();
    const p = this.repo.require(params.proposalId);
    if (p.status !== "open") {
      if (p.status !== (params.accept ? "accepted" : "declined"))
        throw new RpcError(-32602, "routine_proposal_unavailable");
      return this.repo.resolve(p.id, params.accept);
    }
    if (!params.accept) {
      const result = transaction(this.s.deps.db, () => {
        const r = this.repo.resolve(p.id, false);
        this.audit(r.proposal);
        return r;
      });
      this.changed(result.proposal);
      return result;
    }
    this.active(p.botId);
    const old = p.payload.routineId ? this.s.require(p.payload.routineId) : undefined;
    if (old && (old.version !== p.payload.expectedVersion || old.botId !== p.botId))
      throw new RpcError(-32602, "routine_proposal_unavailable");
    for (const field of p.payload.missingFields) {
      const value = params.edits?.[field as keyof typeof params.edits];
      const known = Object.hasOwn(RoutineDraftSchema.shape, field);
      if (known ? value === undefined : !params.answers?.[field]?.trim())
        throw new RpcError(-32602, "routine_proposal_missing");
    }
    const base = old
      ? {
          botId: old.botId,
          name: old.name,
          instructions: old.instructions,
          triggers: old.triggers.map((t) => t.config),
          workplace: old.workplace,
          preauth: old.preauth.filter((op) => !op.revokedAt).map((op) => op.operation),
          notify: old.notify,
          maxDurationMin: old.maxDurationMin,
          carryLastResult: old.carryLastResult,
          output: old.output,
          missedPolicy: old.missedPolicy,
          enabled: old.enabled,
        }
      : { botId: p.botId };
    const parsed = RoutineDraftSchema.safeParse({ ...base, ...p.payload.draft, ...params.edits });
    if (!parsed.success) throw new RpcError(-32602, "routine_proposal_missing");
    const draft = parsed.data;
    // Changing the assignee cannot inherit the old Bot's consent; explicit edits are fresh consent.
    if (old && old.botId !== draft.botId) draft.preauth = params.edits?.preauth ?? [];
    const answers = Object.fromEntries(
      p.payload.missingFields
        .filter(
          (field) =>
            ![
              "botId",
              "name",
              "instructions",
              "triggers",
              "workplace",
              "preauth",
              "notify",
              "maxDurationMin",
              "carryLastResult",
              "output",
              "missedPolicy",
              "enabled",
            ].includes(field),
        )
        .map((field) => [field, params.answers?.[field]]),
    );
    if (Object.keys(answers).length)
      draft.instructions += `\n用户补充 / User details: ${JSON.stringify(answers)}`;
    if (!RoutineDraftSchema.safeParse(draft).success)
      throw new RpcError(-32602, "routine_proposal_missing");
    return acceptRoutineProposal(this, this.chat, p, old, draft);
  }
}
