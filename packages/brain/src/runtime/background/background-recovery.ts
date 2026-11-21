import { backgroundRestartUsage } from "@pibot/protocol-base";
import {
  type BackgroundCommandsRepo,
  ConversationsRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";

/** Terminal UI state is separate from retained OS cleanup evidence. */
export class BackgroundRecovery {
  private timer?: ReturnType<typeof setTimeout>;
  private work?: Promise<void>;
  private after = "";
  private readonly lifetime = new AbortController();
  constructor(
    private readonly local: LocalService,
    private readonly repo: BackgroundCommandsRepo,
  ) {}

  get pending() {
    return this.repo.hasUnverified();
  }

  async recover(signal: AbortSignal) {
    const { db, peer } = this.local.deps;
    const topics = new Map<string, { botId: string; runId: string; messageId: string }>();
    for (;;) {
      const rows = this.repo.running();
      if (!rows.length) break;
      let confirmed = false;
      try {
        confirmed = !(await this.local.target.background.killOrphans(
          rows.map((row) => ({ group: row.group, processes: row.processes })),
          signal,
        ));
      } catch {
        // Preserve every PID/start identity when the target cannot certify the whole batch.
        this.local.deps.logger.warn("Background orphan cleanup incomplete");
      }
      const reason = confirmed ? "restart" : "restart_unverified";
      const changed = transaction(db, () => {
        const grouped = new Map<string, typeof rows>();
        for (const row of rows) {
          this.repo.finish(row.id, { status: "stopped", stopReason: reason, exitCode: null });
          this.local.approvals.audit.append({
            botId: row.botId,
            runId: row.runId,
            kind: "exec.background.stopped",
            summary: "Background interrupted by restart / 后台命令因重启中断",
            detail: { actor: "system", target: row.id, reasonCode: reason },
          });
          if (!row.conversationId || !new ConversationsRepo(db).get(row.conversationId)) continue;
          const entries = grouped.get(row.conversationId) ?? [];
          entries.push(row);
          grouped.set(row.conversationId, entries);
        }
        return [...grouped].map(([conversationId, entries]) => {
          const first = entries[0];
          if (!first) throw new Error("background_recovery_empty_batch");
          const previous = topics.get(conversationId);
          const messages = new MessagesRepo(db);
          const existing = previous && messages.get(previous.messageId);
          const content = [
            existing?.content ?? "后台命令因重启中断 / Background commands interrupted by restart",
            ...entries.map(
              (row) =>
                row.id +
                (confirmed
                  ? " · 已确认停止 / confirmed stopped"
                  : " · 未确认停止，继续清理，请勿重复执行 / stop unverified; cleanup continues; do not repeat"),
            ),
          ].join("\n");
          // The rows append to one notice per conversation, so the structured counts accumulate;
          // the interface reads them instead of the id-bearing content.
          const previousUsage = backgroundRestartUsage(existing?.usage);
          const usage = {
            systemEvent: true,
            trigger: "background_restart",
            backgroundRestart: {
              stopped: (previousUsage?.stopped ?? 0) + entries.length,
              unverified: (previousUsage?.unverified ?? 0) + (confirmed ? 0 : entries.length),
            },
          };
          const message = existing
            ? messages.update(existing.id, { content, usage })
            : messages.create({
                conversationId,
                role: "assistant",
                status: "done",
                markUnread: true,
                botId: first.botId,
                runId: first.runId,
                content,
                usage,
              });
          if (!message) throw new Error("background_recovery_message_missing");
          return {
            conversationId,
            botId: previous?.botId ?? first.botId,
            runId: previous?.runId ?? first.runId,
            messageId: message.id,
          };
        });
      });
      for (const topic of changed) topics.set(topic.conversationId, topic);
    }
    for (const [conversationId, topic] of topics) {
      const message = new MessagesRepo(db).get(topic.messageId);
      if (!message) throw new Error("background_recovery_message_missing");
      peer.emit("chat.message", {
        botId: topic.botId,
        runId: topic.runId,
        messageId: message.id,
        conversationId,
        message,
      });
    }
    this.repo.prune();
    this.schedule();
  }

  private schedule() {
    if (this.timer || this.work) return;
    if (this.lifetime.signal.aborted || this.local.shutdown.signal.aborted || !this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.work = this.retry()
        .catch(() => {
          this.local.deps.logger.warn("Background orphan cleanup retry failed");
        })
        .finally(() => {
          this.work = undefined;
          this.schedule();
        });
    }, 30_000);
    this.timer.unref?.();
  }

  private async retry() {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.local.shutdown.signal,
      AbortSignal.timeout(15_000),
    ]);
    const rows = this.repo.unverified(this.after);
    if (!rows.length) this.after = "";
    for (const row of rows) {
      signal.throwIfAborted();
      // Rotate even on a failed target call; one unkillable process cannot starve later rows.
      this.after = row.id;
      const left = await this.local.target.background.killOrphans(
        [{ group: row.group, processes: row.processes }],
        signal,
      );
      signal.throwIfAborted();
      if (!left) {
        transaction(this.local.deps.db, () => {
          this.repo.confirmStopped(row.id);
          this.local.approvals.audit.append({
            botId: row.botId,
            runId: row.runId,
            kind: "exec.background.stopped",
            summary: "Restart cleanup confirmed / 已确认重启清理",
            detail: { actor: "system", target: row.id, reasonCode: "restart_cleanup_confirmed" },
          });
        });
        this.local.background.refreshStatus(row.id);
      }
    }
  }

  async dispose() {
    this.lifetime.abort();
    clearTimeout(this.timer);
    await this.work;
  }
}
