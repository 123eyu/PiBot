import {
  IndependentBackgroundStateSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol/background";
import type { connectBackground } from "./background-connection.ts";
import { waitBackgroundExit } from "./background-exit.ts";

type Connection = Awaited<ReturnType<typeof connectBackground>>;

/** A GUI exit that could not prove what the owner did. The message is a loggable code only. */
export class BackgroundStopError extends Error {
  constructor(
    readonly step: "reconnect" | "detach" | "stop_service" | "exit_wait",
    readonly reason: string,
  ) {
    super(`${step}:${reason}`);
  }
}

const reasonOf = (error: unknown, signal: AbortSignal) => {
  if (signal.aborted) return "deadline";
  if (error instanceof RpcError) return `rpc_${Math.abs(error.code)}`;
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]{1,80}$/.test(message) ? message : "unexpected";
};

// Every control is refused with `closed` once the owner's own stop began: a quit Apple event
// delivered to the owner (AppleScript / Dock quit), its tray, or its startup timer. The socket
// also drops when it closes its server. Neither is a failure of the stop; only the exit proves it.
export const ownerStopping = (error: unknown) =>
  (error instanceof RpcError && error.code === RpcErrorCodes.closed) ||
  (error instanceof Error && error.message === "background_disconnected");

/**
 * Detaches this GUI and, when the owner should stop with it, confirms the owner's actual exit.
 * Returns "detached" when the owner keeps running (continue mode); "stopped" only after its
 * descriptor is withdrawn and its PID is gone. Throws BackgroundStopError otherwise; ownership
 * is never released or taken over here, so an unconfirmed stop leaves the owner's claim intact.
 */
export async function drainBackgroundOwner(options: {
  dataDir: string;
  connection: Connection;
  explicitStop: boolean;
  signal: AbortSignal;
  /**
   * The owner only knows a connection after it attached. A detach from a connection
   * that never attached is refused as an internal error, so a startup exit would log a failure
   * for a stop that actually works: the owner notices the GUI disconnect and stops on its own.
   */
  attached: boolean;
  /** Set when the transport is already lost; resolves with a fresh attached connection. */
  reconnect?: (signal: AbortSignal) => Promise<Connection>;
  phase?(phase: "detach_started" | "stop_requested" | "exit_confirmed"): void;
}): Promise<"detached" | "unattached" | "stopped"> {
  const { signal } = options;
  let connection = options.connection;
  const pid = connection.descriptor.pid;
  if (options.reconnect) {
    // A lost transport is most often the owner closing its server on the way out; whichever
    // comes first settles it: its proven exit, or a reconnection to the same live owner.
    const local = new AbortController();
    const both = AbortSignal.any([signal, local.signal]);
    try {
      const first = await Promise.race([
        options.reconnect(both).then((value) => ({ value })),
        waitBackgroundExit(options.dataDir, pid, both).then(() => "exited" as const),
      ]);
      if (first === "exited") return "stopped";
      connection = first.value;
    } catch (error) {
      throw new BackgroundStopError("reconnect", reasonOf(error, signal));
    } finally {
      local.abort();
    }
  }
  // No attach, no detach; and with no explicit stop there is nothing to ask the owner.
  if (!options.attached && !options.explicitStop) return "unattached";
  let step: "detach" | "stop_service" = "detach";
  try {
    // Explicit quit/restart already closes admission and drains the whole writer. Detach
    // would first wait for a separate interactive drain, with its own host-control deadline.
    if (options.attached && !options.explicitStop) {
      options.phase?.("detach_started");
      const state = IndependentBackgroundStateSchema.parse(
        await connection.control({ type: "detach" }, signal),
      );
      if (state.effectiveExitBehavior !== "stop") return "detached";
    }
    step = "stop_service";
    await connection.control({ type: "stop-service" }, signal);
  } catch (error) {
    if (signal.aborted || !ownerStopping(error))
      throw new BackgroundStopError(step, reasonOf(error, signal));
    // Already stopping on its own: nothing left to ask, only its exit to observe.
  }
  options.phase?.("stop_requested");
  try {
    await waitBackgroundExit(options.dataDir, connection.descriptor.pid, signal);
  } catch (error) {
    throw new BackgroundStopError("exit_wait", reasonOf(error, signal));
  }
  options.phase?.("exit_confirmed");
  return "stopped";
}
