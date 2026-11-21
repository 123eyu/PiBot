import type { BackgroundWire } from "@pibot/protocol/background";

const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

/** Only authenticated incoming traffic proves the peer lives; writes alone cannot do that. */
export function createBackgroundHeartbeat(options: {
  send(message: BackgroundWire): void;
  failed(reason: "heartbeat_timeout" | "heartbeat_send_failed"): void;
}) {
  let stopped = false;
  let probing = false;
  let receivedAt = performance.now();
  let timer: ReturnType<typeof setTimeout>;
  let expired: ReturnType<typeof setImmediate> | undefined;
  const dispose = () => {
    stopped = true;
    clearTimeout(timer);
    if (expired) clearImmediate(expired);
  };
  const fail = (reason: "heartbeat_timeout" | "heartbeat_send_failed") => {
    if (stopped) return;
    dispose();
    options.failed(reason);
  };
  const send = (message: BackgroundWire) => {
    try {
      options.send(message);
    } catch {
      fail("heartbeat_send_failed");
    }
  };
  const idle = () => {
    if (stopped) return;
    const remaining = HEARTBEAT_IDLE_MS - (performance.now() - receivedAt);
    if (remaining > 0) {
      timer = setTimeout(idle, remaining);
      return;
    }
    probing = true;
    // Start the deadline when the probe is actually sent, not when an overloaded loop
    // should have sent it. Give queued socket reads a poll turn before declaring failure.
    timer = setTimeout(() => {
      expired = setImmediate(() => fail("heartbeat_timeout"));
    }, HEARTBEAT_TIMEOUT_MS);
    send({ kind: "ping" });
  };
  timer = setTimeout(idle, HEARTBEAT_IDLE_MS);
  return {
    receive(message: BackgroundWire) {
      if (stopped) return false;
      receivedAt = performance.now();
      if (probing) {
        probing = false;
        clearTimeout(timer);
        if (expired) clearImmediate(expired);
        expired = undefined;
        timer = setTimeout(idle, HEARTBEAT_IDLE_MS);
      }
      if (message.kind === "ping") send({ kind: "pong" });
      return message.kind === "ping" || message.kind === "pong";
    },
    dispose,
  };
}
