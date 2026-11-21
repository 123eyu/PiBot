import type { Approval } from "@pibot/protocol-base";
import type { DraftsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

type Lifecycle = { requested(approval: Approval): void; resolved(approval: Approval): void };
/** Live waiters own cancellation; parked routine drafts remain durable and have no live waiter. */
export class DraftWaitRegistry {
  private readonly gates = new Map<string, Lifecycle>();
  private readonly waiting = new Map<
    string,
    { context: ToolRunContext; settle(error?: unknown): void }
  >();
  constructor(
    private readonly local: LocalService,
    private readonly repo: DraftsRepo,
  ) {}
  track(id: string, lifecycle: Lifecycle | undefined) {
    if (lifecycle) this.gates.set(id, lifecycle);
  }
  context(id: string) {
    return this.waiting.get(id)?.context;
  }
  changed(id: string) {
    const row = this.repo.get(id);
    if (!row || row.view.status === "pending" || row.view.status === "sending") return;
    const lifecycle = this.gates.get(id);
    this.gates.delete(id);
    try {
      const approval = this.local.approvals.repo.get(id);
      if (approval) lifecycle?.resolved(approval);
      this.waiting.get(id)?.settle();
    } catch (error) {
      this.local.deps.logger.error("Draft routine gate finalization failed");
      this.waiting.get(id)?.settle(error);
    }
  }
  dispose() {
    for (const waiter of [...this.waiting.values()])
      waiter.settle(new DOMException("Stopped", "AbortError"));
    this.gates.clear();
  }
  wait(
    context: ToolRunContext,
    id: string,
    signal: AbortSignal,
    cancelled: () => void,
    expired: () => void,
  ) {
    const row = this.repo.get(id);
    if (!row || (row.view.status !== "pending" && row.view.status !== "sending"))
      return Promise.resolve();
    if (this.waiting.has(id)) throw new Error("Draft already has a live owner");
    return new Promise<void>((resolve, reject) => {
      context.routineClock?.pause("approval");
      context.executionClock?.pause("approval");
      const timer = setTimeout(expired, Math.max(1, Date.parse(row.view.expiresAt) - Date.now()));
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.waiting.delete(id);
        this.gates.delete(id);
        context.routineClock?.resume("approval");
        context.executionClock?.resume("approval");
      };
      const abort = () => {
        // Park is a transfer of ownership, not a user cancellation or permission grant.
        // Remove the live waiter before publishing cancellation, so it cannot resolve this
        // aborted tool call with a normal receipt while finalizing the durable approval.
        this.waiting.delete(id);
        try {
          if (!context.isParking?.()) cancelled();
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        cleanup();
        reject(signal.reason ?? new DOMException("Stopped", "AbortError"));
      };
      this.waiting.set(id, {
        context,
        settle: (error) => {
          cleanup();
          if (error) reject(error);
          else resolve();
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.changed(id);
    });
  }
}
