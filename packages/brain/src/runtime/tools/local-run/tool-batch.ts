import { PARALLEL_READS } from "@pibot/agent";
import type { PreparedTool } from "../../../core/local-types.ts";

/** Scheduling consumes the existing policy proof; it never grants authority or changes replay. */
export function parallelToolCall(prepared: PreparedTool, platform: string): boolean {
  const { call, result } = prepared;
  if (PARALLEL_READS.has(call.tool)) return true;
  const analysis = result.analysis;
  return (
    call.tool === "run_command" &&
    platform !== "win32" &&
    !prepared.docker &&
    call.input.background !== true &&
    call.input.writePaths === undefined &&
    analysis?.readonly === true &&
    !analysis.incomplete &&
    !analysis.network &&
    analysis.writes.length === 0
  );
}

interface Slot {
  parallel: boolean;
  ready?: { resolve(): void; reject(error: unknown): void };
}

/** FIFO admission with exclusive barriers; active slots survive cancellation until real settlement. */
export class ToolBatch {
  private readonly pending = new Map<string, Slot>();
  private readonly active = new Map<string, Slot>();
  private closed = false;

  isIdle() {
    return !this.closed && this.active.size === 0;
  }

  // pi prepares calls in assistant order before launching a parallel batch.
  reserve(id: string, parallel: boolean) {
    if (this.closed || this.pending.has(id) || this.active.has(id))
      throw new Error("Tool batch admission unavailable");
    this.pending.set(id, { parallel });
  }

  private pump() {
    if (this.closed) return;
    while (this.active.size < 4) {
      const [id, slot] = this.pending.entries().next().value ?? [];
      if (!id || !slot?.ready) return;
      if (
        this.active.size &&
        (!slot.parallel || [...this.active.values()].some((s) => !s.parallel))
      )
        return;
      this.pending.delete(id);
      this.active.set(id, slot);
      slot.ready.resolve();
      if (!slot.parallel) return;
    }
  }

  async run<T>(id: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const slot = this.pending.get(id);
    if (!slot || slot.ready || this.closed) throw new Error("Tool batch admission unavailable");
    const abort = () => {
      // An acquired slot belongs to the action, even when its signal has already fired.
      if (!this.pending.delete(id)) return;
      slot.ready?.reject(signal.reason);
      this.pump();
    };
    try {
      await new Promise<void>((resolve, reject) => {
        slot.ready = { resolve, reject };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else this.pump();
      });
      signal.removeEventListener("abort", abort);
      signal.throwIfAborted();
      return await action();
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(id);
      this.pump();
    }
  }

  /** SDK validation / permit failures can finish a prepared call without invoking execute. */
  skip(id: string) {
    const slot = this.pending.get(id);
    if (!slot) return;
    this.pending.delete(id);
    slot.ready?.reject(new Error("Tool batch call ended before dispatch"));
    this.pump();
  }

  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.skip(id);
  }
}
