import { LinkError } from "../core/bytes.ts";
import type { PathEndpoint } from "./path-endpoint.ts";
import { DirectConnectionError, type DirectFailure } from "./rtc-diagnostics.ts";

/**
 * Round trips that prove a direct path before the business Peer is switched onto it.
 *
 * v0.0.2 phone test (5G, phone VPN in TUN mode, Mac behind a proxy TUN): the hole-punched channel
 * opened and finished the Noise handshake, then no RPC was ever answered after the switch, and
 * every switch cost an outage. ICE checks, DTLS and the Noise messages are all small packets; an
 * RPC answer or an event usually is not. A path that drops full-size packets (the MTU black hole
 * of a UDP-in-tunnel proxy is the usual cause) carries the small ones and then stalls the ordered
 * data channel for good at the first large message. So the initiator asks for a small and then a
 * large answer, each way, while the relay is still the business path; a path that fails either is
 * never selected, nothing is frozen meanwhile, and the code says which size failed.
 *
 * Wire compatibility: the probe is a JSON-RPC request on a direct endpoint that is not selected
 * yet. Every desktop with direct paths answers such a request with a
 * `transport_switching` error carrying the same id and never dispatches it, so an older desktop
 * proves the phone-to-computer direction; a newer one also sends `echo` characters back, which
 * proves the other direction. The method is a read in case a peer ever dispatched it anyway.
 */
export const PROBE_ID_PREFIX = "link-probe:";
const PROBE_METHOD = "devices.self";
/** Several full-size SCTP packets in both directions (the channel packs about 1.2 KB each). */
const PROBE_PAD = 6000;
const PROBE_ECHO_MAX = 16_384;
const PROBE_TIMEOUT_MS = 5000;

type Message = Record<string, unknown>;
const isProbe = (message: Message) =>
  typeof message.id === "string" &&
  message.id.length <= 128 &&
  message.id.startsWith(PROBE_ID_PREFIX);

export class PathProbes {
  private waiting = new Map<string, () => void>();
  private next = 0;

  /**
   * Consumes probe traffic on a direct endpoint: answers a probe request (any role) and resolves
   * a waiting probe of ours. True when the message was a probe and must go no further.
   */
  receive(endpoint: PathEndpoint, message: Message) {
    if (!isProbe(message)) return false;
    if (typeof message.method === "string") {
      const params = (message.params ?? {}) as { echo?: unknown; pad?: unknown };
      const echo =
        Number.isSafeInteger(params.echo) && (params.echo as number) > 0
          ? Math.min(params.echo as number, PROBE_ECHO_MAX)
          : 0;
      endpoint.probed =
        typeof params.pad === "string" && params.pad.length >= PROBE_PAD
          ? "large"
          : (endpoint.probed ?? "small");
      try {
        endpoint.wire.port.post({
          jsonrpc: "2.0",
          id: message.id,
          result: echo ? { pad: "x".repeat(echo) } : {},
        });
      } catch {
        /* A wire that cannot send fails the asker's probe; its own close handling retires it. */
      }
      return true;
    }
    this.waiting.get(message.id as string)?.();
    return true;
  }

  /** Throws DirectConnectionError(`probe_failed` | `path_mtu`), or LinkError when aborted. */
  async run(endpoint: PathEndpoint, signal: AbortSignal) {
    const steps: [number, DirectFailure][] = [
      // Small first: a stuck large message would hold back anything after it on the channel.
      [0, "probe_failed"],
      [PROBE_PAD, "path_mtu"],
    ];
    for (const [size, reason] of steps) {
      const id = `${PROBE_ID_PREFIX}${++this.next}`;
      try {
        await new Promise<void>((resolve, reject) => {
          const lifetime = AbortSignal.any([signal, endpoint.wire.closed]);
          const finish = (error?: Error) => {
            clearTimeout(timer);
            lifetime.removeEventListener("abort", abort);
            this.waiting.delete(id);
            if (error) reject(error);
            else resolve();
          };
          const abort = () => finish(new LinkError("path_closed"));
          const timer = setTimeout(
            () => finish(new DirectConnectionError(reason)),
            PROBE_TIMEOUT_MS,
          );
          this.waiting.set(id, () => finish());
          lifetime.addEventListener("abort", abort, { once: true });
          if (lifetime.aborted) return abort();
          try {
            endpoint.wire.port.post({
              jsonrpc: "2.0",
              id,
              method: PROBE_METHOD,
              params: size ? { pad: "x".repeat(size), echo: size } : {},
            });
          } catch {
            finish(new DirectConnectionError("channel_failed"));
          }
        });
      } catch (error) {
        // A channel that closed under the probe failed as a channel, not as an aborted attempt.
        if (!signal.aborted && endpoint.wire.closed.aborted)
          throw new DirectConnectionError("channel_failed");
        throw error;
      }
    }
  }

  dispose() {
    this.waiting.clear();
  }
}
