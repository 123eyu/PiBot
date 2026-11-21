import type { LocalToolCall } from "@pibot/agent";
import { type PolicyResult, YOLO_REASON } from "@pibot/policy";
import { type ConversationYolo, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  ConversationYoloRepo,
  GroupsRepo,
  transaction,
} from "@pibot/storage";
import { ZodError } from "zod";
import type { LocalService } from "../local-service.ts";
import { abortable } from "./abort.ts";
import { auditText, auditToolFields } from "./audit-fields.ts";
import type { ToolRunContext } from "./local-types.ts";

/**
 * Whether this run's decisions are under its conversation's YOLO switch. Only chat runs of
 * a DM topic or a group conversation (and its task threads); scheduled runs and trials never are.
 * Read at every decision, so turning it off returns to asking at the next one.
 */
export function runYolo(local: LocalService, context: ToolRunContext): boolean {
  if (context.executionTaskId) return local.taskAuthority.yolo(context);
  if (context.routineRunId || context.routineSource || !context.conversationId) return false;
  return new ConversationYoloRepo(local.deps.db).active(context.conversationId, context.groupId);
}

export function allowedByYolo(result: PolicyResult): boolean {
  return result.decision === "allow" && result.reason === YOLO_REASON;
}

/**
 * Records one action YOLO let through (rule 6: every approval-equivalent is audited). It is an
 * automatic resolution with reason `yolo`; nothing is remembered.
 */
export function auditYolo(
  local: LocalService,
  context: ToolRunContext,
  call: Pick<LocalToolCall, "id" | "tool" | "input">,
  result: PolicyResult,
) {
  const { redactor } = local.deps;
  local.approvals.audit.append({
    botId: context.botId,
    runId: context.runId,
    kind: "approval.resolved",
    summary: "Allowed by YOLO / YOLO 自动允许",
    detail: {
      ...auditToolFields(call, redactor, result, local.deps.capabilityTools),
      botName: auditText(new BotsRepo(local.deps.db).get(context.botId)?.name ?? "Bot", redactor),
      source: "chat",
      toolCallId: call.id,
      decision: "allow",
      remember: false,
      actor: "automatic",
      reasonCode: YOLO_REASON,
      risk: result.risk,
      ...(context.groupId ? { groupId: context.groupId } : {}),
    },
  });
}

/** `conversations.yolo.get` / `set`: the switch itself, its audit and the pending cards. */
export class YoloService {
  private readonly repo: ConversationYoloRepo;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly runListeners = new Map<
    string,
    { context: ToolRunContext; actions: Set<() => Promise<void>> }
  >();
  constructor(private readonly local: LocalService) {
    this.repo = new ConversationYoloRepo(local.deps.db);
  }

  async get(conversationId: string): Promise<ConversationYolo> {
    return { ...this.state(conversationId), isolation: await this.isolation(conversationId) };
  }

  async set(conversationId: string, enabled: boolean): Promise<ConversationYolo> {
    const before = this.state(conversationId);
    const conversation = this.repo.switchable(conversationId);
    if (!conversation) throw new RpcError(-32602, "yolo_unavailable");
    const state =
      before.enabled === enabled
        ? before
        : transaction(this.local.deps.db, () => {
            const value = this.repo.set(conversationId, enabled);
            this.audit(conversation, enabled);
            return value;
          });
    if (state !== before) this.local.deps.peer.emit("conversations.yolo.changed", state);
    // Recommended: cards already waiting in this conversation go through as allowed.
    if (enabled) {
      await this.releasePending(conversation.id, conversation.groupId ?? undefined);
      for (const listener of [...(this.listeners.get(conversation.id) ?? [])]) listener();
      for (const entry of [...this.runListeners.values()]) {
        try {
          const source = entry.context.executionTaskId
            ? this.local.taskAuthority.source(entry.context)
            : entry.context;
          if (source.conversationId !== conversation.id || !runYolo(this.local, entry.context))
            continue;
          const actions = [...entry.actions];
          entry.actions.clear();
          for (const action of actions) {
            try {
              await action();
            } catch {
              // Each card is independent; one stale proposal must not strand other live waiters.
              this.local.deps.logger.warn(
                "YOLO pending business confirmation could not be applied",
              );
            }
          }
        } catch {
          this.local.deps.logger.warn("YOLO pending business confirmation could not be applied");
        }
      }
    }
    return { ...state, isolation: await this.isolation(conversationId) };
  }

  /** Only live run waiters subscribe; their abort/settlement always removes the listener. */
  onEnabled(conversationId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(conversationId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(conversationId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(conversationId);
    };
  }

  onRunEnabled(context: ToolRunContext, action: () => Promise<void>) {
    const entry = this.runListeners.get(context.runId) ?? { context, actions: new Set() };
    entry.actions.add(action);
    this.runListeners.set(context.runId, entry);
  }

  releaseRun(runId: string) {
    this.runListeners.delete(runId);
  }

  private state(conversationId: string) {
    try {
      return this.repo.get(conversationId);
    } catch (error) {
      // No such switch here: unknown/archived/draft IDs, routine topics and task threads refuse
      // with TypeError; a stored row the schema cannot read is equally not switchable.
      if (error instanceof TypeError || error instanceof ZodError)
        throw new RpcError(RpcErrorCodes.invalidParams, "yolo_unavailable");
      throw error;
    }
  }

  /**
   * The command isolation shown in the confirm text. Right after startup the sandbox runtime may
   * still be starting (busy) or miss its 10 s deadline; ExecError carries no RPC code, so it used
   * to surface as `internal` and hide the switch. Not knowing is reported as not isolated, which
   * only adds the stronger warning to the confirm text; the switch itself does not depend on it.
   */
  private async isolation(conversationId: string): Promise<ConversationYolo["isolation"]> {
    const signal = AbortSignal.any([this.local.shutdown.signal, AbortSignal.timeout(20_000)]);
    try {
      const target = this.local.targetFor(this.executionLocation(conversationId));
      return await abortable(target.isolationStatus(signal), signal);
    } catch (error) {
      if (this.local.shutdown.signal.aborted)
        throw new RpcError(RpcErrorCodes.closed, "Brain stopping");
      // The owner's 25 warnings were all a runner topic read in the first second after
      // startup, before the runner link connected (`targetFor` → runner_target_offline). That is
      // an expected state, not a sandbox fault; the confirm text still warns as unisolated.
      const offline = error instanceof RpcError && error.message === "runner_target_offline";
      this.local.deps.logger[offline ? "info" : "warn"](
        JSON.stringify({
          module: "yolo",
          event: "isolation_unknown",
          reason: offline
            ? "runner_offline"
            : error instanceof RpcError
              ? error.message.slice(0, 64)
              : error instanceof Error
                ? error.name
                : "unknown",
        }),
      );
      return { available: false, reason: offline ? "runner_offline" : "isolation_unknown" };
    }
  }

  /**
   * A topic whose primary folder is on a paired computer runs its commands there, so the
   * confirm text must describe that computer's isolation. This desktop's own sandbox says nothing
   * about whether the other machine isolates anything. Anything unresolvable stays "this device",
   * which only makes the warning stronger.
   */
  private executionLocation(conversationId: string): { target: string } | undefined {
    const topic = new ConversationsRepo(this.local.deps.db).get(conversationId);
    const folderId = topic?.workplaceFolderId;
    if (!topic?.botId || !folderId || folderId === "home") return undefined;
    const location = this.local.workplaces.repo
      .folders(topic.botId, [folderId])
      .get(folderId)?.location;
    return location ? { target: location } : undefined;
  }

  private audit(
    conversation: NonNullable<ReturnType<ConversationYoloRepo["switchable"]>>,
    enabled: boolean,
  ) {
    const { db, redactor } = this.local.deps;
    const group = conversation.groupId ? new GroupsRepo(db).get(conversation.groupId) : undefined;
    const botId = conversation.botId ?? group?.coordinatorBotId;
    if (!botId) throw new RpcError(-32602, "yolo_unavailable");
    this.local.approvals.audit.append({
      botId,
      kind: "yolo.changed",
      summary: enabled ? "YOLO turned on / 已开启 YOLO" : "YOLO turned off / 已关闭 YOLO",
      detail: {
        actor: "user",
        reasonCode: enabled ? "yolo_on" : "yolo_off",
        target: conversation.id,
        ...(group
          ? { groupId: group.id, groupName: auditText(group.name, redactor) }
          : { botName: auditText(new BotsRepo(db).get(botId)?.name ?? "Bot", redactor) }),
      },
    });
  }

  /**
   * Re-judges waiting cards. Search gets ephemeral authorization; ambiguous login is rejected
   * as missing input rather than left waiting or answered with an arbitrary account.
   */
  private async releasePending(conversationId: string, groupId?: string) {
    await this.local.computerGrants.runs.releaseForYolo();
    await this.local.drafts.releaseForYolo(conversationId, groupId);
    const approvals = this.local.approvals.waitingIn((context) => {
      if (context.routineRunId || context.routineSource) return false;
      try {
        const source = context.executionTaskId ? this.local.taskAuthority.source(context) : context;
        return groupId ? source.groupId === groupId : source.conversationId === conversationId;
      } catch {
        return false;
      }
    });
    for (const approval of approvals) {
      try {
        if (approval.computer) await this.local.computerGrants.resolveForYolo(approval);
        else await this.local.approvals.resolve(approval.id, "allow", false, false, "yolo");
      } catch {
        // Changed/missing input cannot leave an application approval waiting in YOLO. A card
        // already resolved by its re-judgement or another click needs no second resolution.
        if (this.local.approvals.waitingIn(() => true).some((item) => item.id === approval.id))
          await this.local.approvals.resolve(approval.id, "deny", false, false, "yolo");
        this.local.deps.logger.warn(`YOLO could not resolve a pending approval id=${approval.id}`);
      }
    }
  }
}
