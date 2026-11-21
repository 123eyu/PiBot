import type { DatabaseSync } from "node:sqlite";
import { type AgentRuntime, mapAgentError } from "@pibot/agent";
import {
  boundMessageForward,
  type KernelMethodParams,
  type MessageTransferReceipt,
  RpcError,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  BotsRepo,
  ConversationsRepo,
  MessagesRepo,
  MessageTransfersRepo,
  SettingsRepo,
  transaction,
} from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import type { BrainRedactor } from "../../core/privacy.ts";
import type { ChatService } from "./chat.ts";
import { messageDigest, selectedMessages } from "./message-selection.ts";

interface Dependencies {
  db: DatabaseSync;
  chat: ChatService;
  groups: GroupOrchestrationPort;
  agent: AgentRuntime;
  redactor: BrainRedactor;
  signal: AbortSignal;
  report(reason: "message_transfer_rejected" | "message_transfer_failed"): void;
}
export function registerMessageActions(handle: KernelRegisterRpc, deps: Dependencies) {
  const service = new MessageActions(deps);
  handle(
    "messages.selection",
    async (input) => selectedMessages(deps.db, input, deps.redactor).summary,
  );
  handle("messages.translate", (input) => service.translate(input));
  handle("messages.handoff", (input) => service.handoff(input));
  handle("messages.transfer", (input) => service.transfer(input));
  handle(
    "messages.transferStatus",
    async ({ requestId }) => service.receipts.get(requestId)?.receipt ?? null,
  );
}
export class MessageActions {
  readonly receipts: MessageTransfersRepo;
  private readonly transfers = new Map<string, Promise<MessageTransferReceipt>>();
  private readonly translations = new Map<
    string,
    Promise<{ text: string; language: "zh" | "en" }>
  >();
  constructor(private readonly deps: Dependencies) {
    this.receipts = new MessageTransfersRepo(deps.db);
    this.receipts.recover();
  }
  translate(input: KernelMethodParams["messages.translate"]) {
    const { db, redactor, signal } = this.deps;
    signal.throwIfAborted();
    const selected = selectedMessages(
      db,
      { conversationId: input.conversationId, messageIds: [input.messageId] },
      redactor,
    );
    const text = redactor.redact(selected.messages[0]?.content ?? "");
    if (!text.trim() || text.length > 30000)
      throw new RpcError(-32602, "translation_text_unavailable");
    return this.transform(selected, text, input.language, "translation");
  }
  async handoff(input: KernelMethodParams["messages.handoff"]) {
    const selected = selectedMessages(this.deps.db, input, this.deps.redactor);
    const history = new MessagesRepo(this.deps.db).list(input.conversationId, { limit: 100 });
    let limited = history.length === 100,
      used = 0;
    const records: { role: string; sender: string; at: string; text: string }[] = [];
    const chosen = new Set(input.messageIds);
    const bots = new BotsRepo(this.deps.db);
    for (const message of [...history].reverse()) {
      if (
        chosen.has(message.id) ||
        message.status === "streaming" ||
        !["user", "assistant"].includes(message.role)
      )
        continue;
      const original = this.deps.redactor.redact(message.content);
      const text = original.slice(0, 5000);
      if (text.length < original.length) limited = true;
      if (used + text.length > 45000) {
        limited = true;
        break;
      }
      used += text.length;
      records.push({
        role: message.role,
        sender: message.botId ? (bots.get(message.botId)?.name ?? "Bot") : "User",
        at: message.createdAt,
        text,
      });
    }
    const source = JSON.stringify({
      boundedContext: records.reverse(),
      limited,
      selectedMessages: selected.text,
    });
    const result = await this.transform(
      selected,
      this.deps.redactor.redact(source),
      input.language,
      "handoff",
    );
    if (result.text.length > 12000) throw new RpcError(-32602, "handoff_too_large");
    return { text: result.text, sourceCount: records.length + selected.messages.length, limited };
  }
  private transform(
    selected: ReturnType<typeof selectedMessages>,
    text: string,
    language: "zh" | "en",
    kind: "translation" | "handoff",
  ) {
    const { db, agent, redactor, signal } = this.deps;
    signal.throwIfAborted();
    const key = messageDigest([text, language, kind]);
    const existing = this.translations.get(key);
    if (existing) return existing;
    if (this.translations.size >= 4) throw new RpcError(-32011, "translation_busy");
    const bot = selected.botId ? new BotsRepo(db).get(selected.botId) : undefined;
    // An external agent's chat never goes to Pi Bot's own model (no default fallback).
    if (bot?.kind === "agent") throw new RpcError(-32602, "no_model");
    const model =
      bot?.category !== "image" && bot?.modelProvider && bot.modelId
        ? { provider: bot.modelProvider, id: bot.modelId }
        : new SettingsRepo(db).get().defaultModel;
    if (!model || !agent.transformMessage) throw new RpcError(-32602, "no_model");
    const task = agent.transformMessage({ model, text, language, kind, signal }).then(
      (text) => ({ text: redactor.redact(text), language }),
      (error: unknown) => {
        throw new RpcError(-32602, mapAgentError(error));
      },
    );
    this.translations.set(key, task);
    void task.finally(() => this.translations.delete(key)).catch(() => {});
    return task;
  }
  transfer(input: KernelMethodParams["messages.transfer"]) {
    this.deps.signal.throwIfAborted();
    const hash = messageDigest(input);
    const old = this.receipts.get(input.requestId);
    if (old) {
      if (old.hash !== hash) throw new RpcError(-32602, "message_transfer_changed");
      return this.transfers.get(input.requestId) ?? Promise.resolve(old.receipt);
    }
    if (this.transfers.size >= 8) throw new RpcError(-32011, "message_transfer_busy");
    const selected = selectedMessages(this.deps.db, input, this.deps.redactor);
    if (selected.summary.hash !== input.selectionHash)
      throw new RpcError(-32602, "message_selection_changed");
    this.receipts.create(input.requestId, hash);
    const task = this.deliver(input, selected);
    this.transfers.set(input.requestId, task);
    void task.finally(() => this.transfers.delete(input.requestId)).catch(() => {});
    return task;
  }
  private destination(input: KernelMethodParams["messages.transfer"]): MessageTransferReceipt {
    const { db, groups } = this.deps,
      target = input.destination;
    if (target.kind === "bot") {
      const bot = new BotsRepo(db).get(target.botId);
      if (!bot || bot.archivedAt) throw new RpcError(-32602, "message_target_unavailable");
      const topic = new ConversationsRepo(db).currentDm(bot.id);
      return {
        requestId: input.requestId,
        state: "pending",
        botId: bot.id,
        conversationId: topic.id,
      };
    }
    if (target.kind === "newGroup") {
      if (!target.botIds.includes(target.coordinatorBotId))
        throw new RpcError(-32602, "message_group_members_changed");
      const group = groups.create({
        name: target.name,
        botIds: target.botIds,
        coordinatorBotId: target.coordinatorBotId,
      });
      return {
        requestId: input.requestId,
        state: "pending",
        groupId: group.id,
        conversationId: group.conversationId,
      };
    }
    const group = groups.groups.get(target.groupId);
    if (!group || group.conversationId !== target.topicId)
      throw new RpcError(-32602, "message_target_changed");
    return {
      requestId: input.requestId,
      state: "pending",
      groupId: group.id,
      conversationId: group.conversationId,
    };
  }
  private async deliver(
    input: KernelMethodParams["messages.transfer"],
    selected: ReturnType<typeof selectedMessages>,
  ) {
    const { db, chat, groups, redactor } = this.deps;
    const signal = AbortSignal.any([this.deps.signal, AbortSignal.timeout(90_000)]);
    let receipt: MessageTransferReceipt = { requestId: input.requestId, state: "pending" };
    let dispatched = false;
    try {
      receipt = transaction(db, () => {
        const bound = this.destination(input);
        this.receipts.save(bound);
        return bound;
      });
      const attachments = await chat.attachments.forwardingInputs(selected.attachments, signal);
      signal.throwIfAborted();
      const fresh = selectedMessages(db, input, redactor);
      if (fresh.summary.hash !== input.selectionHash)
        throw new RpcError(-32602, "message_selection_changed");
      const summary = input.handoffSummary ? redactor.redact(input.handoffSummary) : undefined;
      const note = input.note ? redactor.redact(input.note) : undefined;
      // The model text is unchanged by FORWARD-DISPLAY (prompt cache and untrusted framing); the
      // bubble shows the note and a card built from the same redacted parts.
      const text = `${selected.text}${input.handoffSummary ? `\n\nHandoff summary / 交接摘要（引用资料，以原文为准）：\n${summary}` : ""}${input.note ? `\n\nUser request / 用户补充：\n${note}` : ""}`;
      const forward = boundMessageForward({
        source: selected.source,
        messages: selected.display,
        summary,
        note,
      });
      dispatched = true;
      const sent = receipt.groupId
        ? await groups.send(
            {
              groupId: receipt.groupId,
              topicId: receipt.conversationId,
              text,
              attachments,
            },
            undefined,
            undefined,
            { forward },
          )
        : await chat.send(
            receipt.botId as string,
            text,
            attachments,
            [],
            receipt.conversationId,
            false,
            undefined,
            undefined,
            undefined,
            { forward },
          );
      receipt = {
        ...receipt,
        state: "done",
        userMessageId: sent.userMessageId,
        conversationId: sent.conversationId ?? receipt.conversationId,
      };
      new AuditRepo(db, redactor).append({
        botId:
          receipt.botId ??
          groups.groups.get(receipt.groupId as string)?.coordinatorBotId ??
          (selected.botId as string),
        kind: "exec.finished",
        summary: "Selected messages forwarded / 已转发所选消息",
        detail: {
          actor: "user",
          reasonCode: "messages_transferred",
          messageCount: selected.messages.length,
          target: receipt.groupId ?? receipt.botId,
        },
      });
    } catch (error) {
      this.deps.report(
        error instanceof RpcError ? "message_transfer_rejected" : "message_transfer_failed",
      );
      // A send may have committed before its response was lost; a receipt never authorizes replay.
      receipt = { ...receipt, state: dispatched ? "uncertain" : "failed" };
    }
    this.receipts.save(receipt);
    return receipt;
  }
}
