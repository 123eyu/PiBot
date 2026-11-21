export class RestartPolicy {
  private exits: number[] = [];
  private stopped = false;

  recordExit(now: number): "restart" | "failed" {
    if (this.stopped) return "failed";
    this.exits = this.exits.filter((time) => now - time <= 30_000);
    this.exits.push(now);
    this.stopped = this.exits.length >= 3;
    return this.stopped ? "failed" : "restart";
  }
}
