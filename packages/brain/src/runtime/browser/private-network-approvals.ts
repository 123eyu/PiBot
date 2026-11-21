// Bounded: one run approving dozens of devices is already unusual; the card count limits it too.
const MAX_PER_RUN = 64;

/**
 * Maintainers 2026-11-14: the local-network targets a person allowed in one run, through a card that
 * nothing else can answer (PRIVATE_NETWORK_REASON). Bot-browser origins (`http://host:port`) and
 * command / ping hosts (`host`) are kept apart by their spelling. Memory only: nothing is
 * remembered, and the run's end forgets them.
 */
export class PrivateNetworkApprovals {
  private readonly runs = new Map<string, Set<string>>();

  approve(runId: string, targets: readonly string[]) {
    let approved = this.runs.get(runId);
    if (!approved) {
      approved = new Set();
      this.runs.set(runId, approved);
    }
    for (const target of targets) if (approved.size < MAX_PER_RUN) approved.add(target);
  }

  approved(runId: string): string[] {
    return [...(this.runs.get(runId) ?? [])];
  }

  /** Command hosts only: what the run's sandbox proxy may reach besides the network settings. */
  hosts(runId: string): string[] {
    return this.approved(runId).filter((target) => !target.includes("://"));
  }

  /** Bot-browser origins only, for the host's network rules. */
  origins(runId: string): string[] {
    return this.approved(runId).filter((target) => target.includes("://"));
  }

  finishRun(runId: string) {
    this.runs.delete(runId);
  }
}
