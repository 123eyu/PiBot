// performance.now is the execution budget; wall clock is only for persisted timestamps.
export class RoutineClock {
  private elapsed = 0;
  private since: number | null = performance.now();
  private readonly pauses = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  timedOut = false;
  constructor(
    private readonly limit: number,
    private readonly abort: () => void,
  ) {
    this.arm();
  }
  value() {
    return Math.max(
      0,
      Math.floor(this.elapsed + (this.since === null ? 0 : performance.now() - this.since)),
    );
  }
  pause(reason: string) {
    if (!this.pauses.size) {
      this.elapsed = this.value();
      this.since = null;
    }
    this.pauses.add(reason);
    clearTimeout(this.timer);
  }
  resume(reason: string) {
    this.pauses.delete(reason);
    if (!this.pauses.size && this.since === null) {
      this.since = performance.now();
      this.arm();
    }
  }
  private arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timedOut = true;
        this.abort();
      },
      Math.max(1, this.limit - this.value()),
    );
  }
  dispose() {
    this.pause("disposed");
  }
}
