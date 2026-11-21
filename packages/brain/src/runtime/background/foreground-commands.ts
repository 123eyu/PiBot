import { randomUUID } from "node:crypto";
import type { BackgroundJob, CommandPromotion } from "@pibot/execution";
import { type ForegroundCommandState, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";

export interface ForegroundSource {
  context: ToolRunContext;
  prepared: PreparedTool;
  assertCurrent(): void;
}
interface Entry {
  source: ForegroundSource;
  request: AbortController;
  job: BackgroundJob;
}
const key = (runId: string, toolCallId: string) => `${runId}:${toolCallId}`;

/** Holds only ready, authorized foreground calls; RPC can request a handoff, never a spawn. */
export class ForegroundCommands {
  private stopping = false;
  private readonly retired = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly ports: {
      refusal(context: ToolRunContext): string | undefined;
      adopt(
        source: ForegroundSource,
        job: BackgroundJob,
        trigger: "timeout" | "user",
        seconds: number,
      ): boolean;
      emit(state: ForegroundCommandState): void;
      change(id: string): void;
      progress(id: string): void;
    },
  ) {}

  prepare(source: ForegroundSource): { promotion: CommandPromotion; dispose(): void } {
    const id = randomUUID();
    const request = new AbortController();
    const { context, prepared } = source;
    const callKey = key(context.runId, prepared.call.id);
    return {
      promotion: {
        id,
        request: request.signal,
        ready: (job) => {
          if (context.signal.aborted || this.stopping || this.retired.has(context.botId)) return;
          this.entries.set(callKey, { source, request, job });
          this.refresh();
        },
        promote: (job, trigger, seconds) => {
          if (this.stopping || this.retired.has(context.botId)) return false;
          source.assertCurrent();
          if (!job.running || context.signal.aborted || this.ports.refusal(context)) return false;
          return this.ports.adopt(source, job, trigger, seconds);
        },
        callbacks: {
          onChange: () => this.ports.change(id),
          onProgress: () => this.ports.progress(id),
        },
      },
      dispose: () => {
        this.entries.delete(callKey);
        this.ports.emit({
          botId: context.botId,
          runId: context.runId,
          toolCallId: prepared.call.id,
          active: false,
          available: false,
        });
      },
    };
  }

  get(botId: string, runId: string, toolCallId: string): ForegroundCommandState | null {
    const entry = this.entries.get(key(runId, toolCallId));
    if (!entry || this.stopping || this.retired.has(botId) || entry.source.context.botId !== botId)
      return null;
    const reason = this.ports.refusal(entry.source.context);
    return {
      botId,
      runId,
      toolCallId,
      active: entry.job.running,
      available: entry.job.running && !reason,
      ...(reason ? { reason: "limit" as const } : {}),
    };
  }

  promote(botId: string, runId: string, toolCallId: string) {
    const state = this.get(botId, runId, toolCallId);
    if (!state?.active || !state.available)
      throw new RpcError(RpcErrorCodes.busy, "foreground_not_available");
    this.entries.get(key(runId, toolCallId))?.request.abort();
    return { ok: true as const };
  }

  refresh() {
    for (const entry of this.entries.values()) {
      const { context, prepared } = entry.source;
      const state = this.get(context.botId, context.runId, prepared.call.id);
      if (state) this.ports.emit(state);
    }
  }

  accepting(botId: string) {
    return !this.stopping && !this.retired.has(botId);
  }

  retire(botId?: string) {
    if (botId) this.retired.add(botId);
    else this.stopping = true;
    for (const entry of this.entries.values()) {
      const { context, prepared } = entry.source;
      if (!botId || context.botId === botId)
        this.ports.emit({
          botId: context.botId,
          runId: context.runId,
          toolCallId: prepared.call.id,
          active: false,
          available: false,
        });
    }
  }
  restore(botId: string) {
    this.retired.delete(botId);
  }

  dispose() {
    this.entries.clear();
  }
}
