import type { SocketLike } from "@pibot/link";

export function reportSocketRetired(
  stage: "relay" | "lan",
  reason: "close_timeout" | "terminate_failed" | "detach_failed",
) {
  console.warn(JSON.stringify({ module: "mobile-link", stage, event: "retired", reason }));
}

/** RN has no public terminate; native close and JS subscription retirement are separate. */
export function retireSocket(socket: SocketLike, stage: "relay" | "lan") {
  const native = socket as SocketLike & {
    terminate?(): void;
    _close?(code: number, reason: string): void;
    _unregisterEvents?(): void;
  };
  try {
    if (native.terminate) native.terminate();
    else native._close?.(1001, "retired");
  } catch {
    reportSocketRetired(stage, "terminate_failed");
  }
  // RN 0.88 otherwise retains NativeEventEmitter subscriptions until websocketClosed/Failed.
  try {
    native._unregisterEvents?.();
  } catch {
    reportSocketRetired(stage, "detach_failed");
    throw new Error("drain_unconfirmed");
  }
}
