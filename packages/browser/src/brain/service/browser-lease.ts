import type { BrowserEnvironment, BrowserRunScope } from "@pibot/brain/kit";
import { RpcError } from "@pibot/browser-contract/full";

type Owner = Pick<BrowserRunScope, "botId" | "runId">;
interface Lease {
  runId: string;
  active: boolean;
  ready: Promise<void>;
}

/** The host has one browser profile per Bot; its permissions cannot belong to two runs. */
export class BrowserLeases {
  private readonly owners = new Map<string, Lease>();
  constructor(
    private readonly local: BrowserEnvironment,
    private readonly groupId?: string,
  ) {}
  async acquire(owner: Owner, signal: AbortSignal, temporary = false) {
    signal.throwIfAborted();
    const previous = this.owners.get(owner.botId);
    if (previous?.runId === owner.runId) return previous.ready;
    if (previous?.active) throw new RpcError(-32011, "browser_resource_busy");
    // Publish before the first await, including a still-unconfirmed handoff. A timeout is not
    // proof the host finished draining, so its run keeps this lease until actual SDK drain.
    let refused = false;
    const ready = Promise.resolve().then(async () => {
      const host = this.local.deps.host.browser;
      if (host) {
        try {
          await host.call(
            "host.browser.handoff",
            {
              botId: owner.botId,
              runId: owner.runId,
              ...(temporary ? { temporary: true } : {}),
              ...(this.groupId ? { groupId: this.groupId } : {}),
            },
            AbortSignal.any([signal, this.local.shutdown.signal, AbortSignal.timeout(15_000)]),
          );
        } catch (error) {
          // Only an explicit host refusal proves handoff never started; timeouts keep ownership.
          refused = temporary && error instanceof RpcError && error.code === -32011;
          signal.throwIfAborted();
          throw new RpcError(-32011, "browser_resource_busy");
        }
      }
      signal.throwIfAborted();
    });
    const lease = { runId: owner.runId, active: true, ready };
    this.owners.set(owner.botId, lease);
    try {
      await ready;
    } catch (error) {
      if (refused && this.owners.get(owner.botId) === lease) this.owners.delete(owner.botId);
      throw error;
    }
  }
  assert(owner: Owner) {
    const lease = this.owners.get(owner.botId);
    if (!lease?.active || lease.runId !== owner.runId)
      throw new RpcError(-32011, "browser_resource_busy");
  }
  owns(owner: Owner) {
    const lease = this.owners.get(owner.botId);
    return lease?.active === true && lease.runId === owner.runId;
  }
  /** Dispatch barrier only: even a rejected/timed-out handoff still needs a host quiesce. */
  async handoffSent(owner: Owner) {
    const lease = this.owners.get(owner.botId);
    if (lease?.runId !== owner.runId) return;
    await lease.ready.then(
      () => {},
      () => {},
    );
  }
  /** Only RunQueue calls this after generateRun certified the SDK/tools actually exited. */
  drained(owner: Owner) {
    const lease = this.owners.get(owner.botId);
    if (lease?.runId === owner.runId) lease.active = false;
  }
  dispose() {
    this.owners.clear();
  }
}
