import {
  type HostParams,
  KeepAwakeLeaseSchema,
  KeepAwakeRequestSchema,
  type PowerSupplySchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { z } from "zod";

export type PowerSupply = z.infer<typeof PowerSupplySchema>;
export interface Blocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}
export function createPowerLease(options: {
  blocker: Blocker;
  now?: () => number;
  monotonic?: () => number;
  changed(status: "requested" | "unsupported" | "off"): void;
  warn(): void;
}) {
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  let epoch = 0,
    active = false;
  let supply: PowerSupply = "unknown";
  let blockerId: number | undefined;
  let releaseFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lease:
    | { request: HostParams["host.keepAwake"]; expires: number; deadline: number }
    | undefined;
  let waitingSince: number | undefined;
  let waitingLimit = 1_800_000;
  let status: "requested" | "unsupported" | "off" = "off";
  function publish(next: typeof status) {
    if (status !== next) {
      status = next;
      options.changed(next);
    }
  }
  function release() {
    if (blockerId !== undefined) {
      try {
        options.blocker.stop(blockerId);
      } catch {
        options.warn();
        releaseFailed = true;
        publish("unsupported");
        return;
      }
      blockerId = undefined;
    }
    releaseFailed = false;
    publish("off");
  }
  function reconcile() {
    clearTimeout(timer);
    const remaining = lease ? lease.deadline - monotonic() : 0;
    if (!active || !lease || remaining <= 0) {
      lease = undefined;
      release();
      return;
    }
    timer = setTimeout(reconcile, remaining);
    // Retain ownership after a native stop error; never silently reuse a lock from an old epoch.
    if (releaseFailed) {
      release();
      if (releaseFailed) return;
    }
    if (lease.request.mode === "on_ac" && supply !== "ac") {
      release();
      return;
    }
    if (blockerId === undefined) {
      try {
        blockerId = options.blocker.start("prevent-app-suspension");
        publish("requested");
      } catch {
        publish("unsupported");
        options.warn();
      }
    }
  }
  return {
    begin(next: number) {
      release();
      clearTimeout(timer);
      lease = undefined;
      waitingSince = undefined;
      epoch = next;
      active = true;
    },
    waitingLimit(ms: number) {
      waitingLimit = ms;
    },
    end() {
      active = false;
      lease = undefined;
      waitingSince = undefined;
      clearTimeout(timer);
      release();
    },
    supply(next: PowerSupply) {
      supply = next;
      reconcile();
    },
    status: () => status,
    request(owner: number, input: HostParams["host.keepAwake"]) {
      if (!active || owner !== epoch) throw new RpcError(RpcErrorCodes.closed, "stale_brain_epoch");
      const request = KeepAwakeRequestSchema.parse(input);
      if (request.mode === "never" || request.reason === "none") {
        lease = undefined;
        waitingSince = undefined;
        clearTimeout(timer);
        release();
      } else {
        if (request.reason === "waiting") waitingSince ??= monotonic();
        else waitingSince = undefined;
        const duration =
          waitingSince === undefined
            ? request.leaseMs
            : Math.max(0, Math.min(request.leaseMs, waitingLimit - (monotonic() - waitingSince)));
        lease = { request, expires: now() + duration, deadline: monotonic() + duration };
        reconcile();
      }
      return KeepAwakeLeaseSchema.parse({
        status,
        leaseId: request.leaseId,
        expiresAt: status === "requested" && lease ? new Date(lease.expires).toISOString() : null,
      });
    },
  };
}
