import type { ToolRunContext } from "@pibot/brain/kit";

/** How a hand-off ended, as the agent run reported it. The reply is redacted agent text. */
export interface DelegationOutcome {
  status: "done" | "error" | "aborted";
  reply: string;
  code?: string;
}

interface Entry {
  /** The delegating Bot's live run: its topic shows the agent's cards. */
  from: ToolRunContext;
  settle(outcome: DelegationOutcome): void;
}

/**
 * Hand-offs in flight, keyed by the agent run doing the work. In memory only: a hand-off
 * lives exactly as long as the delegating run's tool call, which a restart ends as well.
 */
export class AgentDelegations {
  private readonly runs = new Map<string, Entry>();
  /** Delegating runs with a hand-off in flight (one at a time per run). */
  private readonly sources = new Set<string>();

  /** Reserves the delegating run before the agent run exists, so a parallel call is refused. */
  reserve(sourceRunId: string) {
    if (this.sources.has(sourceRunId)) return undefined;
    this.sources.add(sourceRunId);
    return () => {
      this.sources.delete(sourceRunId);
    };
  }

  /** Starts tracking an agent run; the promise settles when that run reports its end. */
  track(
    runId: string,
    from: ToolRunContext,
  ): { ended: Promise<DelegationOutcome>; release(): void } {
    let settle: (outcome: DelegationOutcome) => void = () => {};
    const ended = new Promise<DelegationOutcome>((resolve) => {
      settle = resolve;
    });
    this.runs.set(runId, { from, settle });
    return {
      ended,
      release: () => {
        if (this.runs.get(runId)?.from === from) this.runs.delete(runId);
      },
    };
  }

  /** The delegating run whose topic shows this agent run's cards, while it is still waiting. */
  from(runId: string): ToolRunContext | undefined {
    const entry = this.runs.get(runId);
    return entry && !entry.from.signal.aborted ? entry.from : undefined;
  }

  /** Called by the agent run when it ends, however it ends; unknown runs are ignored. */
  finish(runId: string, outcome: DelegationOutcome) {
    this.runs.get(runId)?.settle(outcome);
  }
}
