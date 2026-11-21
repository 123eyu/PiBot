/** Admission is bounded; stop rejects queued work and waits for the actual consumer. */
export class TriggerQueue {
  private readonly lifetime = new AbortController();
  private readonly pending: {
    run(signal: AbortSignal): Promise<void>;
    reject(error: unknown): void;
  }[] = [];
  private current?: Promise<void>;
  constructor(private readonly capacity = 128) {}
  isIdle() {
    return !this.current && this.pending.length === 0;
  }
  async drain() {
    while (this.current) await this.current;
  }
  submit<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted || this.pending.length >= this.capacity)
      return Promise.reject(new Error("trigger_queue_unavailable"));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run: async (signal) => {
          try {
            resolve(await action(signal));
          } catch (e) {
            reject(e);
          }
        },
        reject,
      });
      this.pump();
    });
  }
  private pump() {
    if (this.current || this.lifetime.signal.aborted) return;
    const entry = this.pending.shift();
    if (!entry) return;
    const running = entry.run(this.lifetime.signal);
    this.current = running;
    void running.finally(() => {
      this.current = undefined;
      this.pump();
    });
  }
  async stop() {
    this.lifetime.abort();
    for (const entry of this.pending.splice(0)) entry.reject(new Error("trigger_queue_stopped"));
    await this.current;
  }
}
