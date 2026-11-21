import type { BrainCapability } from "@pibot/brain/kit";
import { registerGroupMemoryRpc } from "./group-memory-service.ts";
import { MemoryExtractionQueue } from "./memory-extraction-queue.ts";
import { registerMemoryImport } from "./memory-import.ts";
import { registerMemoryManagement } from "./memory-management.ts";
import { MemoryOrganizationQueue } from "./memory-organization-queue.ts";
import { proposeScopeMoves } from "./memory-scope-moves.ts";
import { MemoryService, registerMemoryRpc } from "./memory-service.ts";
import { executeMemoryReadTool, executeMemoryTool } from "./memory-tools.ts";

export function memoryCapability(): BrainCapability {
  return {
    id: "memory",
    register(ctx) {
      const memory = new MemoryService(ctx.db, ctx.peer, ctx.redactor, () =>
        ctx.logger.warn(
          JSON.stringify({ module: "memory", reasonCode: "memory_usage_write_failed" }),
        ),
      );
      registerMemoryRpc(ctx.rpc.handle, memory);
      // Both workers call the same auxiliary model, so each treats a running run of the
      // other as busy. Two parallel model calls would double the burst on a small local model and
      // make the shared daily budget overshoot before either result is written.
      let extraction: MemoryExtractionQueue | undefined;
      const healthChanged = () => ctx.peer.emit("inbox.changed", {});
      const organization = new MemoryOrganizationQueue({
        db: ctx.db,
        redactor: ctx.redactor,
        logger: ctx.logger,
        memory,
        healthChanged,
        isIdle: () => ctx.chat.queue.isIdle() && (extraction?.idle() ?? true),
        draftMemories: ctx.agent.draftMemories?.bind(ctx.agent),
      });
      ctx.rpc.handle("memory.sortIntoPlace", async ({ runId }, { signal }) =>
        organization.sortIntoPlace(runId, signal, (value) =>
          ctx.peer.emit("memory.sortProgress", value),
        ),
      );
      ctx.rpc.handle("memory.cancelSortIntoPlace", async ({ runId }) => {
        await organization.cancelSortIntoPlace(runId);
        return { ok: true as const };
      });
      extraction = new MemoryExtractionQueue({
        db: ctx.db,
        redactor: ctx.redactor,
        logger: ctx.logger,
        memory,
        healthChanged,
        isIdle: () => organization.idle(),
        isBotIdle: (botId) => ctx.chat.queue.isBotIdle(botId),
        onBotWork: (listener) => ctx.chat.queue.onBotWork(listener),
        draftMemories: ctx.agent.draftMemories?.bind(ctx.agent),
      });
      extraction.start();
      organization.start();
      // Maintainers 2026-11-11: offer to hand Bot work facts back from the shared user scope. Pure SQL
      // and pattern checks over at most a few hundred notes; idempotent per note, so every start
      // may run it and only notes never asked about before produce proposals.
      try {
        const moved = proposeScopeMoves(memory, ctx.db);
        if (moved.notes || moved.failed)
          ctx.logger.info?.(
            JSON.stringify({
              module: "memory",
              reasonCode: "memory_scope_moves_proposed",
              ...moved,
            }),
          );
      } catch {
        // Only a proposal pass: a failure leaves every note where it is and is retried next start.
        ctx.logger.warn(
          JSON.stringify({ module: "memory", reasonCode: "memory_scope_moves_failed" }),
        );
      }
      registerMemoryManagement(ctx.rpc.handle, ctx.db, ctx.peer, ctx.redactor, memory);
      registerMemoryImport(ctx.rpc.handle, ctx.host);
      registerGroupMemoryRpc(ctx.rpc.handle, memory);
      const releasePort = ctx.memory.provide({
        personal: memory,
        group: { prompt: (groupId, botId, request) => memory.groupPrompt(groupId, botId, request) },
      });
      const releaseTools = (["memory_add", "memory_update", "memory_remove"] as const).map((tool) =>
        ctx.tools.delegateKernel(tool, (context, call, signal, authorization) =>
          executeMemoryTool(memory, ctx.local, context, call, signal, authorization),
        ),
      );
      // Reads never ask, so they take no authorization and stay in this capability.
      const releaseReads = (["memory_search", "memory_read"] as const).map((tool) =>
        ctx.tools.delegateKernel(tool, (context, call, signal) =>
          executeMemoryReadTool(memory, ctx.local, context, call, signal),
        ),
      );
      return {
        async stop() {
          await organization.stop();
          await extraction?.stop();
          memory.stop();
          for (const release of [...releaseTools, ...releaseReads].reverse()) release();
          releasePort();
        },
      };
    },
  };
}
