import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "@pibot/observability";
import { type HostMethods, type Peer, RpcError, RpcErrorCodes } from "@pibot/protocol";

/** Only the read-only transport probe is replayable; host actions retain their own semantics. */
export async function waitForHost(
  peer: Peer<typeof HostMethods, Record<string, never>>,
  logger: Pick<Logger, "info" | "warn">,
  signal: AbortSignal,
) {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const started = performance.now();
    logger.info(JSON.stringify({ module: "startup", event: "host_rpc_sent", attempt }));
    try {
      await peer.call("host.backgroundState", undefined, { timeoutMs: 3000, signal });
      logger.info(
        JSON.stringify({
          module: "startup",
          event: "host_rpc_received",
          attempt,
          durationMs: Math.round(performance.now() - started),
        }),
      );
      return;
    } catch (error) {
      if (
        signal.aborted ||
        attempt >= 3 ||
        !(error instanceof RpcError) ||
        error.code !== RpcErrorCodes.timeout
      )
        throw error;
      logger.warn(JSON.stringify({ module: "startup", event: "host_rpc_retry", attempt }));
      await delay(500 * attempt, undefined, { signal });
    }
  }
}
