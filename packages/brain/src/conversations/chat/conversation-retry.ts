import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { forkRetrySession } from "@pibot/agent";
import type { KernelEvents, KernelMethods, Peer } from "@pibot/protocol-base";
import { messageForward, messageVisibleText, RpcError } from "@pibot/protocol-base";
import {
  AttachmentsRepo,
  AuditRepo,
  SettingsRepo,
  TopicFoldersRepo,
  TopicsRepo,
  transaction,
} from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import { resolvePersonaLanguage } from "../../core/personas/language.ts";
import type { BrainRedactor } from "../../core/privacy.ts";
import type { ManagedResourcesPort } from "../../runtime/workspaces/port.ts";
import type { ChatService } from "./chat.ts";

import { createConversationRetryPlan } from "./conversation-retry-plan.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const restoreId = (request: string, checkpoint: string) => {
  const h = hash([request, checkpoint]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** User-only operation: source/history are authoritative; neither a model nor the UI picks files. */
export function registerConversationRetry(
  handle: KernelRegisterRpc,
  chat: ChatService,
  resources: ManagedResourcesPort,
  deps: {
    db: DatabaseSync;
    dataDir: string;
    redactor: BrainRedactor;
    peer: Peer<typeof KernelMethods, typeof KernelEvents>;
    platform: NodeJS.Platform;
    waitForSessionRecovery(signal: AbortSignal): Promise<void>;
  },
) {
  const { db, redactor, peer } = deps;
  const { repo, messages, conversations, target, source, plan } = createConversationRetryPlan(deps);
  repo.recover();
  handle("chat.retryPreview", (input) =>
    resources.retry(target(input), async (scope, signal, files) => {
      const p = await plan(input, scope, signal, files);
      return { hash: p.hash, fileCount: p.fileCount, restoreFiles: p.restoreFiles };
    }),
  );
  handle("chat.retryStatus", async (input) => {
    source(input);
    return repo.receipt(input.requestId, input) ?? null;
  });
  handle("chat.retryDraft", async (input) => {
    const topic = conversations.get(input.conversationId);
    if (topic?.kind !== "dm" || topic.botId !== input.botId || topic.archivedAt)
      throw new RpcError(-32602, "retry_source_unavailable");
    if (topic.routineId || conversations.isInternal(topic.id)) return null;
    const draft = repo.draft(input.botId, input.conversationId);
    return draft
      ? // FORWARD-DISPLAY: editing a forward starts from the note, not the hidden material.
        { text: redactor.redact(messageVisibleText(draft)), attachments: draft.attachments ?? [] }
      : null;
  });
  handle("chat.retryFromMessage", (input) => {
    source(input);
    const existing = repo.receipt(input.requestId, input, input.hash);
    if (existing) return Promise.resolve(existing);
    return chat.changeTopicWorkplace(input.botId, input.conversationId, () =>
      resources.retry(target(input), async (scope, signal, files) => {
        await deps.waitForSessionRecovery(signal);
        const p = await plan(input, scope, signal, files);
        if (p.hash !== input.hash) throw new RpcError(-32602, "retry_preview_changed");
        source(input);
        repo.begin(input.requestId, input, input.hash);
        let fork: Awaited<ReturnType<typeof forkRetrySession>> | undefined,
          committed = false;
        try {
          new AuditRepo(db, redactor).append({
            botId: input.botId,
            kind: "exec.started",
            summary: "Conversation retry / 从消息重来",
            detail: {
              actor: "user",
              reasonCode: "conversation_retry_from_message",
              conversationId: input.conversationId,
              target: input.requestId,
            },
          });
          for (const { cp, items, target: restoreTarget } of p.restores) {
            const result = await resources.checkpoints.restore(
              {
                target: restoreTarget,
                id: cp.id,
                requestId: restoreId(input.requestId, cp.id),
                expectedVersion: cp.version,
                itemIds: items.map((item) => item.id),
              },
              signal,
            );
            if (result.state !== "done") throw new RpcError(-32602, "retry_restore_incomplete");
          }
          signal.throwIfAborted();
          source(input);
          const branched = await forkRetrySession({ ...p.session, expectedHash: p.inspected.hash });
          fork = branched;
          transaction(db, () => {
            signal.throwIfAborted();
            source(input);
            const topic = conversations.create({
              botId: input.botId,
              piSessionFile: branched.sessionFile,
              workplace: new TopicFoldersRepo(db).selection(input.conversationId),
            });
            const suffix =
              resolvePersonaLanguage(
                new SettingsRepo(db).get().language,
                Intl.DateTimeFormat().resolvedOptions().locale,
              ) === "en"
                ? " (retry)"
                : "（重来）";
            new TopicsRepo(db).rename(
              input.botId,
              topic.id,
              (p.topic.title ?? "").slice(0, 190) + suffix,
            );
            const attachments = new AttachmentsRepo(db);
            for (const old of p.before) {
              if (!["user", "assistant"].includes(old.role) || old.status === "streaming") continue;
              const forward = messageForward(old);
              const copy = messages.create({
                conversationId: topic.id,
                role: old.role,
                content: redactor.redact(old.content),
                status: old.status,
                markUnread: false,
                // A copied forward keeps its card instead of showing the raw material.
                ...(forward ? { usage: { forward } } : {}),
              });
              attachments.linkRetry(old.id, copy.id);
              const boundary = repo.boundary(old.id);
              repo.bind(
                copy.id,
                branched.sessionFile,
                boundary?.entry ?? "",
                boundary?.origin ?? old.id,
              );
            }
            repo.finish(input.requestId, topic.id);
            new AuditRepo(db, redactor).append({
              botId: input.botId,
              kind: "exec.finished",
              summary: "Conversation retry / 从消息重来",
              detail: {
                actor: "user",
                reasonCode: "conversation_retry_from_message",
                conversationId: topic.id,
                target: input.requestId,
              },
            });
            conversations.switchTopic(input.botId, topic.id);
            return topic;
          });
          committed = true;
          peer.emit("sidebar.changed", { conversationKey: `dm:${input.botId}` });
          const receipt = repo.receipt(input.requestId, input);
          if (!receipt) throw new Error("retry_receipt_missing");
          return receipt;
        } catch (error) {
          if (!committed) {
            try {
              repo.fail(input.requestId);
              new AuditRepo(db, redactor).append({
                botId: input.botId,
                kind: "exec.finished",
                summary: "Conversation retry failed / 从消息重来失败",
                detail: {
                  actor: "user",
                  reasonCode: "conversation_retry_from_message",
                  conversationId: input.conversationId,
                  target: input.requestId,
                },
              });
            } finally {
              await fork?.discard();
            }
          }
          throw error;
        }
      }),
    );
  });
}
