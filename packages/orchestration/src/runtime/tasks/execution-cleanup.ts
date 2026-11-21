import { RunCleanup } from "@pibot/brain/orchestration-kit";

/** Keep the original cleanup certificate separate from handing its write lease to the next run. */
export class ExecutionCleanup {
  private readonly cleanup = new RunCleanup();
  private readonly held = new Map<string, { release(): void; draining?: Promise<void> }>();
  hold(runId: string, settling: Promise<void>, release: () => void) {
    if (this.held.has(runId)) return;
    this.held.set(runId, { release });
    this.cleanup.hold(runId, settling, () => {
      // The queue awaits its completion observers before releasing the actual lease below.
    });
  }
  drain(runId: string, beforeRelease?: () => Promise<void>): Promise<void> {
    const entry = this.held.get(runId);
    if (!entry) return beforeRelease?.() ?? Promise.resolve();
    entry.draining ??= (async () => {
      await this.cleanup.drain(runId);
      await beforeRelease?.();
      entry.release();
      this.held.delete(runId);
    })();
    // A failed observer stays a failed drain. Duplicate callers neither rerun it nor free its lock.
    return entry.draining;
  }
}
