/** Cleanup starts at tool shutdown, but isolation is released only after its owner certifies drain. */
export class RunCleanup {
  private readonly pending = new Map<string, { settled: Promise<boolean>; release(): void }>();
  hold(runId: string, settling: Promise<void>, release: () => void) {
    if (this.pending.has(runId)) return;
    // Observe rejection immediately without converting it into a successful drain certificate.
    const settled = settling.then(
      () => true,
      () => false,
    );
    this.pending.set(runId, { settled, release });
  }
  async drain(runId: string) {
    const entry = this.pending.get(runId);
    if (!entry) return;
    if (!(await entry.settled)) throw new Error("Run cleanup unconfirmed");
    entry.release();
    this.pending.delete(runId);
  }
}
