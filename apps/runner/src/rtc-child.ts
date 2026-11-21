import { createNativeRunnerRtcFactory } from "./rtc-native.ts";

export function runRtcChild() {
  if (!process.send) throw new Error("runner_rtc_ipc_required");
  const lifetime = new AbortController();
  const send = (value: unknown) => {
    if (process.connected) process.send?.(value, () => {});
  };
  const factory = createNativeRunnerRtcFactory(() => send({ event: { type: "close" } }));
  let peer: Awaited<ReturnType<typeof factory.createPeer>> | undefined;
  let channel: ReturnType<NonNullable<typeof peer>["createDataChannel"]> | undefined;
  let started = false;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    lifetime.abort();
    await factory.close();
    if (process.connected) process.disconnect?.();
  };
  const stop = () => void close().catch(() => process.exit(1));
  process.once("disconnect", stop);
  process.on("message", (message: RtcRequest) => {
    if (closing) return;
    if (message.op === "close") return stop();
    const run = async () => {
      if (message.op === "init") {
        if (started) throw new Error("runner_rtc_already_started");
        started = true;
        peer = await factory.createPeer({
          ...message.options,
          signal: lifetime.signal,
          onDiagnostic: (event) => send({ diagnostic: event }),
        });
        peer.onCandidate((value) => send({ candidate: value }));
        void peer.waitDataChannel().then(attach, () => {});
        return;
      }
      if (!peer) throw new Error("runner_rtc_not_ready");
      switch (message.op) {
        case "channel":
          attach(peer.createDataChannel());
          break;
        case "offer":
          return peer.createOffer();
        case "answer":
          return peer.acceptOffer(message.value);
        case "accept":
          return peer.acceptAnswer(message.value);
        case "candidate":
          return peer.addCandidate(message.value);
        case "threshold":
          if (channel) channel.bufferedAmountLowThreshold = message.value;
          break;
        case "send":
          if (!channel || !Buffer.isBuffer(message.data)) throw new Error("runner_rtc_send_failed");
          channel.send(Uint8Array.from(message.data).buffer);
          return channel.bufferedAmount;
      }
    };
    function attach(value: NonNullable<typeof channel>) {
      if (closing || channel) return;
      channel = value;
      for (const type of ["open", "close", "error", "bufferedamountlow", "message"]) {
        value.addEventListener(type, (event) => send({ event, buffered: value.bufferedAmount }));
      }
      if (value.readyState === "open") send({ event: { type: "open" }, buffered: 0 });
    }
    void run().then(
      (value) => send({ id: message.id, value }),
      () => send({ id: message.id, failed: true }),
    );
  });
}

export type RtcRequest = { id: number } & (
  | { op: "init"; options: { role: "initiator" | "responder"; stunUrl?: string } }
  | { op: "close" | "channel" | "offer" }
  | { op: "answer" | "accept" | "candidate"; value: string }
  | { op: "threshold"; value: number }
  | { op: "send"; data: Buffer }
);
