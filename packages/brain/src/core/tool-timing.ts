import type { ToolPerformance, ToolPhase, ToolTiming } from "@pibot/protocol-base";

/** Nested waits replace their parent phase, so approval time is never counted as execution. */
export class ToolTimer implements ToolTiming {
  private readonly phases = { policy: 0, approvalWait: 0, queue: 0, exec: 0, post: 0 };
  private readonly scopes = new Map<symbol, ToolPhase>();
  private changedAt = performance.now();
  private terminal?: ToolPerformance;
  private cache?: ToolPerformance["cache"];
  private providerFallback?: ToolPerformance["providerFallback"];

  constructor(web = false) {
    if (web) this.web("miss");
  }

  private accrue() {
    const now = performance.now();
    const phase = [...this.scopes.values()].at(-1) ?? "queue";
    this.phases[phase] += now - this.changedAt;
    this.changedAt = now;
  }

  enter(phase: ToolPhase) {
    if (this.terminal) return () => {};
    this.accrue();
    const id = Symbol();
    this.scopes.set(id, phase);
    return () => {
      if (this.terminal || !this.scopes.has(id)) return;
      this.accrue();
      this.scopes.delete(id);
    };
  }

  async measure<T>(phase: ToolPhase, action: () => Promise<T>): Promise<T> {
    const end = this.enter(phase);
    try {
      return await action();
    } finally {
      end();
    }
  }

  web(cache: "hit" | "miss", fallback: ToolPerformance["providerFallback"] = "none") {
    if (this.terminal) return;
    this.cache = cache;
    this.providerFallback = fallback;
  }

  finish(): ToolPerformance {
    if (this.terminal) return this.terminal;
    this.accrue();
    const phases = { ...this.phases };
    for (const phase of Object.keys(phases) as ToolPhase[])
      phases[phase] = Math.max(0, Math.round(phases[phase]));
    this.terminal = {
      durationMs: Object.values(phases).reduce((sum, ms) => sum + ms, 0),
      phases,
      ...(this.cache ? { cache: this.cache, providerFallback: this.providerFallback } : {}),
    };
    this.scopes.clear();
    return this.terminal;
  }
}
