import { randomUUID } from "node:crypto";
import {
  type BrainSleepTicket,
  type BrainWakeControl,
  BrainWakeControlSchema,
  BrainWakeReplySchema,
  type BrainWakeRequestSchema,
  type BrainWakeResult,
  type WakePlan,
} from "@pibot/protocol";
import type { z } from "zod";

/** Local timeout cancels waiting, never certifies remote drain or utility exit. */
export function createBrainWakeBridge(
  send: (request: z.infer<typeof BrainWakeRequestSchema>) => void,
) {
  const pending = new Map<
    string,
    { resolve(result: BrainWakeResult): void; reject(error: Error): void; cleanup(): void }
  >();
  const call = (control: BrainWakeControl, signal?: AbortSignal) =>
    new Promise<BrainWakeResult>((resolve, reject) => {
      signal?.throwIfAborted();
      if (pending.size >= 16) throw new Error("brain_wake_busy");
      const id = randomUUID();
      const finish = (error: Error) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cleanup();
        entry.reject(error);
      };
      const abort = () => finish(new Error("brain_wake_cancelled"));
      const timer = setTimeout(() => finish(new Error("brain_wake_timeout")), 30000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        send({ type: "brain-wake-request", id, control: BrainWakeControlSchema.parse(control) });
      } catch {
        finish(new Error("brain_wake_unavailable"));
      }
    });
  return {
    report: (signal?: AbortSignal) => call({ operation: "report" }, signal),
    prepare: (plan: Pick<WakePlan, "epoch" | "revision">, signal?: AbortSignal) =>
      call({ operation: "prepare", epoch: plan.epoch, revision: plan.revision }, signal),
    commit: (ticket: BrainSleepTicket, signal?: AbortSignal) =>
      call({ operation: "commit", ticket }, signal),
    resume: (
      reason: Extract<BrainWakeControl, { operation: "resume" }>["reason"],
      signal?: AbortSignal,
    ) => call({ operation: "resume", reason }, signal),
    receive(value: unknown) {
      const parsed = BrainWakeReplySchema.safeParse(value);
      if (!parsed.success) return false;
      const entry = pending.get(parsed.data.id);
      if (entry) {
        pending.delete(parsed.data.id);
        entry.cleanup();
        if (parsed.data.ok && parsed.data.result) entry.resolve(parsed.data.result);
        else entry.reject(new Error("brain_wake_failed"));
      }
      return true;
    },
    disconnected() {
      for (const entry of pending.values()) {
        entry.cleanup();
        entry.reject(new Error("brain_wake_disconnected"));
      }
      pending.clear();
    },
  };
}
