import { randomUUID } from "node:crypto";
import {
  type BrainIdleReport,
  type BrainSleepTicket,
  type BrainWakeControl,
  type BrainWakeResult,
  RpcError,
  RpcErrorCodes,
  type WakePlan,
} from "@pibot/protocol-base";
import type { BrainWakeRepo } from "@pibot/storage";

/**
 * Where the brain's standby learns when it must be awake again. A capability with scheduled work
 * (routines) provides it; without one the brain may stand by with nothing planned.
 */
export interface WakeSource {
  /** The host cannot keep a scheduled wake right now: standby is unavailable, not just delayed. */
  suspended(): boolean;
  /** No automatic work is running or being prepared. */
  automationIdle(): boolean;
  plan(input: { epoch: string; revision: number; signal: AbortSignal }): Promise<WakePlan>;
}

const earlier = (a: string | null, b: string) => (a === null || b < a ? b : a);

const NO_WAKE: WakeSource = {
  suspended: () => false,
  automationIdle: () => true,
  plan: async ({ epoch, revision }) => ({
    epoch,
    revision,
    builtAt: new Date().toISOString(),
    nextAt: null,
    checksAt: null,
    pollAt: null,
    folders: [],
    polling: false,
  }),
};

export class BrainSleep {
  private readonly epoch = randomUUID();
  private revision = 0;
  private databaseRevision = -1;
  private phase: BrainIdleReport["phase"] = "working";
  private plan: WakePlan | null = null;
  private ticket?: BrainSleepTicket;
  private timer?: ReturnType<typeof setTimeout>;
  private operation?: Promise<BrainWakeResult>;
  private restoration?: Promise<void>;
  private read?: Promise<BrainWakeResult>;
  private invalidated = false;
  private healthy = true;
  private idleAt: string | null = null;
  private idleMono?: number;
  private wake: WakeSource = NO_WAKE;
  constructor(
    private readonly deps: {
      repo: BrainWakeRepo;
      interactive(): boolean;
      stopping(): boolean;
      requests(): number;
      workIdle(): boolean;
      approvalsIdle(): boolean;
      pause(signal: AbortSignal): Promise<void>;
      resume(): Promise<void>;
      failed(): void;
    },
  ) {}
  /** One provider only: two schedules would each believe they own the next wake. */
  useWakeSource(source: WakeSource) {
    if (this.wake !== NO_WAKE) throw new Error("Wake source already provided");
    this.wake = source;
  }
  /** Pending approvals expire on their own schedule: that wake belongs to the kernel. */
  private async planned(input: { epoch: string; revision: number; signal: AbortSignal }) {
    const plan = await this.wake.plan(input);
    const approval = this.deps.repo.firstApproval();
    return approval ? { ...plan, checksAt: earlier(plan.checksAt, approval) } : plan;
  }
  private stamp() {
    const current = this.deps.repo.revision();
    if (current !== this.databaseRevision) {
      this.databaseRevision = current;
      this.revision++;
    }
    return this.revision;
  }
  private blockers(): BrainIdleReport["blockers"] {
    const d = this.deps,
      blockers: BrainIdleReport["blockers"] = [];
    if (d.stopping()) blockers.push("stopping");
    if (!this.healthy || this.wake.suspended()) blockers.push("unavailable");
    if (d.interactive()) blockers.push("gui");
    if (d.requests()) blockers.push("requests");
    if (!d.workIdle() || d.repo.hasWork()) blockers.push("work");
    if (!d.approvalsIdle()) blockers.push("approvals");
    // Scheduler maintenance is short-lived, not user work; it must drain before preparation.
    if (blockers.length) {
      this.idleMono = undefined;
      this.idleAt = null;
    } else if (this.idleMono === undefined) {
      this.idleMono = performance.now();
      this.idleAt = new Date().toISOString();
    }
    return blockers;
  }
  private reportValue(blockers: BrainIdleReport["blockers"]): BrainIdleReport {
    return {
      phase: this.phase,
      plan: this.plan ? structuredClone(this.plan) : null,
      idleSince: this.idleAt,
      canSleep: blockers.length === 0 && this.phase !== "committed",
      blockers,
    };
  }
  private eligibility(plan: WakePlan | null, automation = true) {
    const blockers = this.blockers();
    if (this.idleMono === undefined || performance.now() - this.idleMono < 180000)
      blockers.push("not_idle");
    if (automation && !this.wake.automationIdle()) blockers.push("automation");
    if (!plan) blockers.push("unavailable");
    else if (
      [plan.nextAt, plan.checksAt, plan.pollAt].some(
        (at) => at !== null && Date.parse(at) - Date.now() <= 600000,
      )
    )
      blockers.push("upcoming");
    return blockers;
  }
  report(): Promise<BrainWakeResult> {
    // Local bridge cancellation does not stop remote IO; keep one real calculation per utility.
    if (this.read) return this.read.then((result) => structuredClone(result));
    const read = this.reportInside();
    this.read = read;
    void read
      .finally(() => {
        if (this.read === read) this.read = undefined;
      })
      .catch(() => {
        // Only consume finally's derived rejection; the original promise is returned to its caller.
      });
    return read.then((result) => structuredClone(result));
  }
  private async reportInside(): Promise<BrainWakeResult> {
    if (this.operation || this.restoration) return { report: this.reportValue(["automation"]) };
    if (this.phase !== "working") return { report: this.reportValue(this.eligibility(this.plan)) };
    const revision = this.stamp();
    const signal = AbortSignal.timeout(10000);
    try {
      const plan = await this.planned({ epoch: this.epoch, revision, signal });
      if (this.phase !== "working" || this.stamp() !== revision)
        return { report: this.reportValue(["stale"]) };
      this.plan = plan;
      return { report: this.reportValue(this.eligibility(this.plan)) };
    } catch {
      this.plan = null;
      return { report: this.reportValue([signal.aborted ? "budget" : "unavailable"]) };
    }
  }
  activity() {
    this.revision++;
    this.idleAt = null;
    this.idleMono = undefined;
    if (this.phase === "prepared" || this.phase === "preparing") {
      this.invalidated = true;
      this.ticket = undefined;
      clearTimeout(this.timer);
      if (!this.operation) void this.restore().catch(() => this.deps.failed());
    }
  }
  interrupt() {
    if (this.phase === "committed" || this.deps.stopping()) return false;
    this.activity();
    return true;
  }
  assertAdmission() {
    if (!this.healthy || this.phase !== "working" || this.operation || this.restoration) {
      this.activity();
      throw new RpcError(RpcErrorCodes.busy, "brain_sleep_prepared");
    }
    this.activity();
  }
  private restore() {
    this.restoration ??= this.deps
      .resume()
      .then(() => {
        if (!this.deps.stopping()) this.phase = "working";
        this.invalidated = false;
        this.ticket = undefined;
        this.plan = null;
      })
      .catch((error: unknown) => {
        this.healthy = false;
        this.deps.failed();
        throw error;
      })
      .finally(() => {
        this.restoration = undefined;
      });
    return this.restoration;
  }
  async ensureWorking() {
    if (this.phase === "committed")
      throw new RpcError(RpcErrorCodes.closed, "brain_sleep_committed");
    if (!this.healthy) throw new RpcError(RpcErrorCodes.closed, "brain_sleep_unavailable");
    if (this.phase === "working" && !this.operation && !this.restoration) return;
    this.activity();
    await this.operation;
    if (this.phase !== "working" || this.restoration) await this.restore();
  }
  async resume(): Promise<BrainWakeResult> {
    this.activity();
    await this.ensureWorking();
    return this.report();
  }
  prepare(epoch: string, revision: number): Promise<BrainWakeResult> {
    if (this.phase !== "working" || this.operation || this.restoration)
      return Promise.resolve({ report: this.reportValue(["automation"]) });
    if (epoch !== this.epoch || revision !== this.stamp())
      return Promise.resolve({ report: this.reportValue(["stale"]) });
    const blockers = this.eligibility(this.plan, false);
    if (blockers.length) return Promise.resolve({ report: this.reportValue(blockers) });
    this.phase = "preparing";
    this.invalidated = false;
    const operation = this.prepareInside(revision);
    this.operation = operation;
    void operation
      .finally(() => {
        if (this.operation === operation) this.operation = undefined;
      })
      .catch(() => {
        // The caller observes the failure; this branch only consumes finally's derived rejection.
      });
    return operation;
  }
  private async prepareInside(revision: number): Promise<BrainWakeResult> {
    const signal = AbortSignal.timeout(30000);
    try {
      await this.deps.pause(signal);
      signal.throwIfAborted();
      const plan = await this.planned({
        epoch: this.epoch,
        revision,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      this.plan = plan;
      const blockers = this.eligibility(plan);
      if (this.invalidated || this.stamp() !== revision) blockers.push("stale");
      if (blockers.length) {
        await this.restore();
        return { report: this.reportValue(blockers) };
      }
      this.phase = "prepared";
      this.ticket = {
        id: randomUUID(),
        epoch: this.epoch,
        revision,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      };
      this.timer = setTimeout(() => this.activity(), 30000);
      this.timer.unref();
      return { report: this.reportValue([]), ticket: { ...this.ticket } };
    } catch {
      await this.restore();
      return { report: this.reportValue(["unavailable"]) };
    }
  }
  commit(ticket: BrainSleepTicket): BrainWakeResult {
    const blockers = this.eligibility(this.plan);
    if (
      this.operation ||
      this.restoration ||
      this.invalidated ||
      this.phase !== "prepared" ||
      !this.ticket ||
      ticket.id !== this.ticket.id ||
      ticket.epoch !== this.ticket.epoch ||
      ticket.revision !== this.ticket.revision ||
      ticket.expiresAt !== this.ticket.expiresAt ||
      ticket.revision !== this.stamp() ||
      Date.parse(ticket.expiresAt) <= Date.now()
    )
      blockers.push("stale");
    if (blockers.length) {
      this.activity();
      return { report: this.reportValue(blockers), committed: false };
    }
    clearTimeout(this.timer);
    this.ticket = undefined;
    this.phase = "committed";
    return { report: this.reportValue([]), committed: true };
  }
  control(input: BrainWakeControl): Promise<BrainWakeResult> {
    switch (input.operation) {
      case "report":
        return this.report();
      case "prepare":
        return this.prepare(input.epoch, input.revision);
      case "commit":
        return Promise.resolve(this.commit(input.ticket));
      case "resume":
        return this.resume();
    }
  }
  dispose() {
    clearTimeout(this.timer);
    this.ticket = undefined;
    this.healthy = false;
  }
  async settled() {
    await Promise.allSettled([this.read, this.operation, this.restoration]);
  }
}
