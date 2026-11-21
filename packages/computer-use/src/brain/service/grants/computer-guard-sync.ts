import type { HostCall } from "@pibot/brain/kit";
import type {
  ComputerGuardAction,
  ComputerGuardEntry,
  HostComputerGuardMethods,
} from "@pibot/computer-use-contract/full";
import type { Logger } from "@pibot/observability";
import { delay } from "./computer-foreground.ts";

const POLL_WAIT_MS = 20_000;
const UPDATE_TIMEOUT_MS = 5_000;

/**
 * Mirrors the gate's runs onto the background process's indicator and collects the
 * user's clicks / stop shortcut by long polling. Updates are coalesced: only the latest snapshot
 * is sent, one at a time. The poll runs only while the indicator shows something, so an idle
 * brain makes no host calls and can go to standby.
 */
export class ComputerGuardSync {
  private pushing = false;
  private dirty = false;
  private shown = false;
  private poll?: AbortController;

  constructor(
    private readonly deps: {
      host: () => HostCall<typeof HostComputerGuardMethods> | undefined;
      snapshot: () => { language: "zh" | "en"; entries: ComputerGuardEntry[] };
      onAction: (action: ComputerGuardAction) => void;
      logger: Pick<Logger, "warn">;
      shutdown: AbortSignal;
    },
  ) {}

  changed(): void {
    this.dirty = true;
    if (!this.pushing) void this.flush();
  }

  dispose(): void {
    this.poll?.abort();
    this.poll = undefined;
  }

  private async flush() {
    const host = this.deps.host();
    if (!host) return;
    this.pushing = true;
    try {
      while (this.dirty && !this.deps.shutdown.aborted) {
        this.dirty = false;
        const snapshot = this.deps.snapshot();
        // Nothing to hide and nothing to show: skip the round trip entirely.
        if (!snapshot.entries.length && !this.shown) continue;
        try {
          await host.call(
            "host.computerGuard.update",
            snapshot,
            AbortSignal.any([this.deps.shutdown, AbortSignal.timeout(UPDATE_TIMEOUT_MS)]),
          );
          this.shown = snapshot.entries.length > 0;
        } catch {
          // The indicator is a display; a failed update is retried with the next change.
          this.deps.logger.warn("computer indicator update unavailable");
        }
        if (snapshot.entries.length) this.startPolling(host);
        else this.dispose();
      }
    } finally {
      this.pushing = false;
    }
  }

  private startPolling(host: HostCall<typeof HostComputerGuardMethods>) {
    if (this.poll) return;
    const controller = new AbortController();
    this.poll = controller;
    const signal = AbortSignal.any([controller.signal, this.deps.shutdown]);
    void (async () => {
      while (!signal.aborted) {
        try {
          const { actions } = await host.call(
            "host.computerGuard.actions",
            { waitMs: POLL_WAIT_MS },
            signal,
          );
          for (const action of actions) this.deps.onAction(action);
        } catch {
          if (signal.aborted) break;
          this.deps.logger.warn("computer indicator actions unavailable");
          await delay(1000, signal).catch(() => {
            // Aborted while backing off; the loop condition ends the poll.
          });
        }
      }
    })();
  }
}
