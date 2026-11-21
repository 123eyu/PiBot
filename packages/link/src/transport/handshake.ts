import { LinkError } from "../core/bytes.ts";
import { type HandshakeOptions, NoiseHandshake } from "../noise/handshake.ts";
import type { BinaryTransport } from "./port.ts";

export type HandshakeFailurePhase =
  | "setup"
  | "read"
  | "write"
  | "finish"
  | "timeout"
  | "cancelled"
  | "transport_closed";

/** Fixed local diagnostics only; never retains the underlying crypto/native error or frames. */
export class NoiseHandshakeError extends LinkError {
  constructor(readonly phase: HandshakeFailurePhase) {
    super("handshake_failed");
  }
}
// No business payload is released until both handshake messages have authenticated.
export function establishNoise(
  transport: BinaryTransport,
  options: HandshakeOptions & { signal: AbortSignal; timeoutMs?: number },
) {
  return new Promise<import("../noise/channel.ts").NoiseChannel>((resolve, reject) => {
    let handshake: NoiseHandshake;
    try {
      if (!options.psk && !options.remoteStatic) throw new LinkError("unknown_peer");
      handshake = new NoiseHandshake(options);
    } catch {
      transport.close();
      reject(new NoiseHandshakeError("setup"));
      return;
    }
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      off();
      options.signal.removeEventListener("abort", abort);
      transport.closed.removeEventListener("abort", abort);
    };
    const fail = (phase: HandshakeFailurePhase) => {
      if (finished) return;
      finished = true;
      cleanup();
      handshake.dispose();
      transport.close();
      reject(new NoiseHandshakeError(phase));
    };
    const abort = () => fail(options.signal.aborted ? "cancelled" : "transport_closed");
    const off = transport.subscribe((frame) => {
      if (finished) return;
      let phase: HandshakeFailurePhase = "read";
      try {
        handshake.read(frame);
        phase = "write";
        if (options.role === "responder") transport.send(handshake.write());
        phase = "finish";
        const channel = handshake.finish();
        finished = true;
        cleanup();
        transport.confirm?.();
        resolve(channel);
      } catch {
        fail(phase);
      }
    });
    const timer = setTimeout(() => fail("timeout"), options.timeoutMs ?? 10_000);
    options.signal.addEventListener("abort", abort, { once: true });
    transport.closed.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted || transport.closed.aborted) {
      abort();
      return;
    }
    if (options.role === "initiator")
      try {
        transport.send(handshake.write());
      } catch {
        fail("write");
      }
  });
}
