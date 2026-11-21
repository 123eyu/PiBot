import { join } from "node:path";
import { type Message, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { OfflineUpload } from "@pibot/remote-contract";
import {
  AuditRepo,
  BotSessionsRepo,
  BotsRepo,
  ConversationsRepo,
  MessagesRepo,
  TopicsRepo,
  transaction,
} from "@pibot/storage";
import type { RemoteOfflineRepo } from "../../store/index.ts";
import type { RemoteResources } from "../runtime/context.ts";

const PHONE_TOOLS = new Set([
  "phone_media",
  "phone_media_get",
  "phone_sms_code",
  "phone_calls",
  "phone_notifications",
]);
const phoneDataOf = (tool: string) =>
  ({
    phone_media: "media",
    phone_media_get: "media_get",
    phone_sms_code: "sms_code",
    phone_calls: "calls",
    phone_notifications: "notifications",
  })[tool] as "media" | "media_get" | "sms_code" | "calls" | "notifications" | undefined;

/**
 * Brings one part of a phone's offline topic into the computer's record. Each item is
 * keyed by the phone's client ID, so a repeated upload (a lost receipt, a retry after a crash)
 * imports nothing twice. Proposal 6 (maintainers 2026-11-14): when the phone names the Bot's topic it
 * was in, the offline turns join that topic in time order (messages sort by their time); a
 * phone that names none, or a topic that is gone, gets a new topic marked as the phone's in its
 * title, as before. Each reply is marked in its usage (`source: phone_local`, device, model).
 * The last part writes the model history, so later replies on the computer see the offline
 * turns as ordinary history.
 */
export class OfflineImport {
  constructor(
    private readonly r: RemoteResources,
    private readonly repo: RemoteOfflineRepo,
    private readonly language: () => "zh" | "en",
  ) {}
  async upload(deviceId: string, input: OfflineUpload, signal: AbortSignal) {
    const db = this.r.ctx.db;
    const bot = new BotsRepo(db).get(input.botId);
    if (!bot || bot.archivedAt)
      throw new RpcError(RpcErrorCodes.invalidParams, "offline_bot_unavailable");
    const device = this.r.devices.active(deviceId);
    const audit = new AuditRepo(db, this.r.ctx.redactor);
    const messages = new MessagesRepo(db, this.r.ctx.dataDir);
    let imported = 0;
    let duplicates = 0;
    const result = transaction(db, () => {
      let topic = this.repo.topic(deviceId, input.localTopicId);
      if (topic && topic.botId !== input.botId)
        throw new RpcError(RpcErrorCodes.invalidParams, "offline_topic_conflict");
      const joined = this.joinable(input);
      if (!topic && joined) {
        this.repo.addTopic(deviceId, input.localTopicId, {
          conversationId: joined,
          botId: input.botId,
          providerId: input.providerId,
          modelId: input.modelId,
        });
        topic = {
          conversationId: joined,
          botId: input.botId,
          providerId: input.providerId,
          modelId: input.modelId,
          seeded: false,
        };
      }
      if (!topic) {
        const conversation = new ConversationsRepo(db).create({ botId: input.botId });
        const zh = this.language() === "zh";
        // The visible source mark: a later reader sees at once where this topic came from.
        new TopicsRepo(db).rename(
          input.botId,
          conversation.id,
          `${zh ? "手机离线对话" : "Phone offline chat"} · ${device.name} · ${input.modelId}`.slice(
            0,
            200,
          ),
        );
        this.repo.addTopic(deviceId, input.localTopicId, {
          conversationId: conversation.id,
          botId: input.botId,
          providerId: input.providerId,
          modelId: input.modelId,
        });
        topic = {
          conversationId: conversation.id,
          botId: input.botId,
          providerId: input.providerId,
          modelId: input.modelId,
          seeded: false,
        };
      }
      const conversationId = topic.conversationId;
      // The user's own topic keeps its title; only a topic made for the phone is named so.
      const own = conversationId !== input.topicId;
      const ids = new Map<string, string>();
      for (const message of input.messages) {
        const known = this.repo.item(deviceId, message.clientId);
        if (known) {
          if (known.targetId) ids.set(message.clientId, known.targetId);
          duplicates++;
          continue;
        }
        const usage =
          message.role === "assistant"
            ? {
                ...(message.usage
                  ? {
                      input: message.usage.input,
                      output: message.usage.output,
                      cacheRead: message.usage.cacheRead,
                      cacheWrite: message.usage.cacheWrite,
                      totalTokens: message.usage.totalTokens,
                      cost: { total: message.usage.costUsd },
                      requests: message.usage.requests,
                    }
                  : {}),
                runModel: { provider: input.providerId, id: input.modelId },
                source: { kind: "phone_local", deviceId },
                stopReason: message.status === "done" ? "stop" : message.status,
                ...(message.tools?.length ? { offlineTools: message.tools } : {}),
              }
            : null;
        const created = messages.create({
          conversationId,
          role: message.role,
          content: this.r.ctx.redactor.redact(message.content),
          status: message.role === "user" ? "done" : message.status,
          usage,
          // The phone's clock: kept for order, but never later than the computer's now.
          createdAt:
            Date.parse(message.createdAt) > Date.now()
              ? new Date().toISOString()
              : message.createdAt,
        });
        this.repo.addItem(deviceId, input.localTopicId, message.clientId, "message", created.id);
        ids.set(message.clientId, created.id);
        imported++;
      }
      if (input.runnerReceipts?.length && own)
        new TopicsRepo(db).rename(
          input.botId,
          conversationId,
          `${this.language() === "zh" ? "手机离线指挥" : "Phone offline control"} · ${device.name} · ${input.modelId}`.slice(
            0,
            200,
          ),
        );
      if (input.runnerReceipts?.length) {
        for (const receipt of input.runnerReceipts) {
          if (this.repo.item(deviceId, receipt.clientId)) {
            duplicates++;
            continue;
          }
          const row = audit.append({
            botId: input.botId,
            kind: "remote.request",
            summary: "Phone offline control / 手机离线指挥",
            detail: {
              actor: "phone",
              deviceId,
              conversationId,
              target: "offline.runner",
              reasonCode: receipt.outcome,
              deviceTarget: receipt.target,
              offlineRunner: receipt,
              toolName: receipt.tool,
              command: receipt.command,
              cwd: receipt.cwd,
              path: receipt.path,
              decision: receipt.outcome === "denied" ? "deny" : "allow",
            },
          });
          this.repo.addItem(deviceId, input.localTopicId, receipt.clientId, "audit", row.id);
          imported++;
        }
      }
      for (const entry of input.audit) {
        if (this.repo.item(deviceId, entry.clientId)) continue;
        const phoneData = phoneDataOf(entry.tool);
        const row = audit.append({
          botId: input.botId,
          kind: phoneData && entry.decision === "allow" ? "phone.data_read" : "remote.request",
          summary:
            phoneData && entry.decision === "allow"
              ? "Bot read phone data offline / Bot 在手机上离线读取了手机数据"
              : "Phone offline tool call / 手机离线工具调用",
          detail: {
            actor: "phone",
            deviceId,
            toolName: entry.tool,
            target: "offline.tool",
            reasonCode: entry.outcome,
            decision: entry.decision,
            conversationId,
            ...(phoneData && PHONE_TOOLS.has(entry.tool) ? { phoneData } : {}),
            ...(entry.itemCount !== undefined ? { itemCount: entry.itemCount } : {}),
          },
        });
        this.repo.addItem(deviceId, input.localTopicId, entry.clientId, "audit", row.id);
      }
      // The privacy ledger of the phone's own model requests: who received the chat, for which
      // Bot, how many messages; never the text (a global ledger does not exist yet).
      for (const entry of input.egress) {
        if (this.repo.item(deviceId, entry.clientId)) continue;
        const row = audit.append({
          botId: input.botId,
          kind: "remote.request",
          summary: "Phone sent the chat to a model vendor / 手机把对话发给了模型厂商",
          detail: {
            actor: "phone",
            deviceId,
            target: "offline.model_request",
            reasonCode: "sent",
            providerId: entry.providerId,
            modelId: entry.modelId,
            messageCount: Math.min(50, entry.messageCount),
            conversationId,
          },
        });
        this.repo.addItem(deviceId, input.localTopicId, entry.clientId, "egress", row.id);
      }
      for (const proposal of input.memory) {
        if (this.repo.item(deviceId, proposal.clientId)) continue;
        const source = ids.get(proposal.messageClientId);
        if (!source) throw new RpcError(RpcErrorCodes.invalidParams, "offline_memory_source");
        let proposed: { proposalId: string } | undefined;
        try {
          proposed = this.r.ctx.local.memory.proposeOffline?.(input.botId, source, {
            text: proposal.text,
            category: proposal.category,
            ...(proposal.why ? { why: proposal.why } : {}),
            ...(proposal.how ? { how: proposal.how } : {}),
          });
        } catch (error) {
          // A proposal the memory rules refuse (quota, conflict) must not block the chat itself
          // forever; it is recorded as handled without a proposal, like a duplicate.
          if (!(error instanceof RpcError)) throw error;
          this.r.ctx.logger.warn(
            JSON.stringify({
              module: "remote.offline",
              event: "proposal_refused",
              code: error.message,
            }),
          );
        }
        this.repo.addItem(
          deviceId,
          input.localTopicId,
          proposal.clientId,
          "memory",
          proposed?.proposalId ?? null,
        );
      }
      return { topicId: conversationId, seeded: topic.seeded, own };
    });
    // Before the model history: a joined topic that is busy still shows the turns at once.
    if (imported) {
      this.r.ctx.peer.emit("sidebar.changed", { conversationKey: `dm:${input.botId}` });
      this.r.ctx.peer.emit("inbox.changed", {});
    }
    if (input.final && !result.seeded)
      await this.seed(deviceId, input, result.topicId, !result.own, signal);
    return { topicId: result.topicId, imported, duplicates };
  }
  /** The Bot's live private topic the phone named, or undefined (then a topic of its own). */
  private joinable(input: OfflineUpload) {
    if (!input.topicId) return undefined;
    const conversation = new ConversationsRepo(this.r.ctx.db).get(input.topicId);
    if (
      conversation?.kind !== "dm" ||
      conversation.botId !== input.botId ||
      conversation.archivedAt ||
      this.r.ctx.local.tasks.tasks.isInternalConversation(conversation.id)
    )
      return undefined;
    return conversation.id;
  }
  /**
   * Writes the topic's model history once; a topic already continued on the computer is kept. A
   * joined topic gets the offline turns after its own session's last entry, never while a run of
   * that topic has the session open (the phone sends the last part again later).
   */
  private async seed(
    deviceId: string,
    input: OfflineUpload,
    conversationId: string,
    joined: boolean,
    signal: AbortSignal,
  ) {
    if (joined && this.r.ctx.chat.topicBusy(input.botId, conversationId))
      throw new RpcError(RpcErrorCodes.busy, "offline_topic_busy");
    const ids = this.repo.messageIds(deviceId, input.localTopicId);
    const repo = new MessagesRepo(this.r.ctx.db, this.r.ctx.dataDir);
    const rows: Message[] = [];
    for (let index = 0; index < ids.length; index += 50)
      rows.push(...repo.selection(conversationId, ids.slice(index, index + 50)));
    rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const model = await this.r.ctx.agent.portableModel?.(input.providerId, input.modelId);
    const botDir = join(this.r.ctx.dataDir, "bots", input.botId);
    // The file the topic's next run opens (same order as the chat run's own choice).
    const recorded = joined
      ? (new BotSessionsRepo(this.r.ctx.db).get(input.botId, conversationId) ??
        new ConversationsRepo(this.r.ctx.db).get(conversationId)?.piSessionFile ??
        undefined)
      : undefined;
    try {
      await this.r.ctx.agent.seedSession?.({
        botId: input.botId,
        homeDir: join(botDir, "home"),
        sessionDir: join(botDir, "sessions"),
        sessionFile: recorded ?? join(botDir, "sessions", `${conversationId}.jsonl`),
        ...(joined ? { append: true } : {}),
        model: {
          api: model?.api ?? "openai-completions",
          provider: input.providerId,
          id: input.modelId,
        },
        messages: rows
          .filter((row) => row.content.trim())
          .map((row) => ({
            role: row.role === "user" ? ("user" as const) : ("assistant" as const),
            text: row.content,
            at: Date.parse(row.createdAt),
          })),
        signal,
      });
    } catch (error) {
      // Somebody already continued this topic on the computer: its own history stands.
      if (!(error instanceof Error && error.message.includes("session_unavailable"))) throw error;
    }
    this.repo.markSeeded(deviceId, input.localTopicId);
  }
}
