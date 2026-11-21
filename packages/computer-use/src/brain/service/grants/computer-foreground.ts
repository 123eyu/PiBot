import { RpcError, RpcErrorCodes } from "@pibot/computer-use-contract/full";

export interface ForegroundLease {
  readonly runId: string;
  readonly generation: number;
}

/**
 * Foreground lock: one Bot run at a time may drive the user's mouse and keyboard; the
 * others queue in arrival order. `foreground()` returns before the step runs and the gate has no
 * "step finished" call, so the holder keeps the lock for a short lease (renewed by its next
 * foreground step) and loses it on release or when the lease runs out.
 */
export class ForegroundLock {
  private holder?: { lease: ForegroundLease; timer: ReturnType<typeof setTimeout> };
  private generation = 0;
  private readonly queue: { runId: string; grant(): void; fail(error: Error): void }[] = [];

  constructor(
    private readonly leaseMs: number,
    private readonly changed: () => void,
  ) {}

  holds(runId: string): boolean {
    return this.holder?.lease.runId === runId;
  }
  /** An expiring foreground lease is not proof that a cancelled driver stopped injecting input. */
  pin(runId: string): ForegroundLease | undefined {
    if (this.holder?.lease.runId !== runId) return undefined;
    clearTimeout(this.holder.timer);
    return this.holder.lease;
  }

  /** Restore the between-step lease only after the host certified this step's completion. */
  renew(runId: string): void {
    if (this.holds(runId)) this.grant(runId);
  }

  /** 1-based queue position, or undefined when the run is not waiting. */
  position(runId: string): number | undefined {
    const index = this.queue.findIndex((entry) => entry.runId === runId);
    return index < 0 ? undefined : index + 1;
  }

  acquire(runId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.holds(runId) || !this.holder) {
      this.grant(runId);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        runId,
        grant: () => {
          signal.removeEventListener("abort", abort);
          this.grant(runId);
          resolve();
        },
        fail: (error: Error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      const abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        this.changed();
        reject(signal.reason ?? new RpcError(RpcErrorCodes.closed, "foreground_cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.changed();
    });
  }

  release(target: string | ForegroundLease): void {
    // A late drain/timer receipt cannot release a newer acquisition by the same run.
    if (typeof target !== "string" && this.holder?.lease !== target) return;
    const runId = typeof target === "string" ? target : target.runId;
    const index = this.queue.findIndex((entry) => entry.runId === runId);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.holder?.lease.runId !== runId) {
      if (index >= 0) this.changed();
      return;
    }
    clearTimeout(this.holder.timer);
    this.holder = undefined;
    const next = this.queue.shift();
    if (next) next.grant();
    else this.changed();
  }

  dispose(): void {
    if (this.holder) clearTimeout(this.holder.timer);
    this.holder = undefined;
    for (const entry of this.queue.splice(0))
      entry.fail(new RpcError(RpcErrorCodes.closed, "foreground_closed"));
  }

  private grant(runId: string) {
    if (this.holder) clearTimeout(this.holder.timer);
    const lease = Object.freeze({ runId, generation: ++this.generation });
    const timer = setTimeout(() => this.release(lease), this.leaseMs);
    timer.unref?.();
    this.holder = { lease, timer };
    this.changed();
  }
}

/** Resolves after `ms`, or rejects when the signal aborts. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
