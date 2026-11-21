import {
  type DataChannelEvent,
  type DataChannelLike,
  dataOnlyRtcSdp,
  parseRtcCandidate,
  type RtcPeerFactory,
  type RtcPeerLike,
  RtcStateSchema,
} from "@pibot/link";
import type { DataChannel, PeerConnection } from "node-datachannel";

/** One network lifetime owns the native library and drains peers before global cleanup. */
export function createNativeRunnerRtcFactory(onPeerClose?: () => void) {
  let loaded: Promise<typeof import("node-datachannel")> | undefined;
  let disposed = false;
  const createPeer: RtcPeerFactory = async (options) => {
    if (disposed) throw new Error("runner_rtc_closed");
    loaded ??= import("node-datachannel");
    let native: typeof import("node-datachannel");
    try {
      native = await loaded;
    } catch {
      throw new Error("unsupported");
    }
    options.signal.throwIfAborted();
    if (disposed) throw new Error("runner_rtc_closed");
    // Native exception text may contain candidate addresses; only fixed diagnostics leave here.
    native.initLogger("Error", () => {});
    return new RunnerRtcPeer(
      new native.PeerConnection("pibot-runner", {
        iceServers: options.stunUrl ? [options.stunUrl] : [],
        disableAutoNegotiation: true,
        maxMessageSize: 64 * 1024,
      }),
      options,
      onPeerClose,
    );
  };
  return {
    createPeer,
    async close() {
      disposed = true;
      // An unsupported binding never created native resources.
      const native = await loaded?.catch(() => undefined);
      native?.cleanup();
    },
  };
}

class RunnerChannel implements DataChannelLike {
  binaryType = "arraybuffer";
  private state: DataChannelLike["readyState"] = "connecting";
  private threshold = 0;
  private readonly listeners = new Map<string, Set<(event: DataChannelEvent) => void>>();
  constructor(private readonly channel: DataChannel) {
    channel.onOpen(() => {
      this.state = "open";
      this.emit("open");
    });
    channel.onClosed(() => {
      this.state = "closed";
      this.emit("close");
      this.listeners.clear();
    });
    channel.onError(() => {
      this.emit("error");
      this.close();
    });
    channel.onBufferedAmountLow(() => this.emit("bufferedamountlow"));
    channel.onMessage((data) => {
      if (typeof data === "string" || data.byteLength > 64 * 1024) return this.close();
      this.emit("message", data);
    });
  }
  private emit(type: string, data?: unknown) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, data });
  }
  get readyState() {
    return this.state === "closed" ? "closed" : this.channel.isOpen() ? "open" : this.state;
  }
  get bufferedAmount() {
    return this.state === "closed" ? 0 : this.channel.bufferedAmount();
  }
  get bufferedAmountLowThreshold() {
    return this.threshold;
  }
  set bufferedAmountLowThreshold(value: number) {
    this.threshold = value;
    this.channel.setBufferedAmountLowThreshold(value);
  }
  send(data: ArrayBuffer) {
    if (
      this.readyState !== "open" ||
      this.bufferedAmount > 4 * 1024 * 1024 ||
      !this.channel.sendMessageBinary(new Uint8Array(data))
    )
      throw new Error("runner_rtc_send_failed");
  }
  close() {
    if (this.state === "closed") return;
    this.state = "closed";
    this.channel.close();
    this.emit("close");
    this.listeners.clear();
  }
  addEventListener(type: string, listener: (event: DataChannelEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: DataChannelEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
}

class RunnerRtcPeer implements RtcPeerLike {
  private channel?: RunnerChannel;
  private closed = false;
  private candidates = new Set<(candidate: string) => void>();
  private waiters = new Set<{
    resolve(channel: DataChannelLike): void;
    reject(error: Error): void;
  }>();
  private description?: { resolve(sdp: string): void; reject(error: Error): void };
  private count = 0;
  private bytes = 0;
  private allowStun: boolean;
  constructor(
    private readonly peer: PeerConnection,
    private readonly options: Parameters<RtcPeerFactory>[0],
    private readonly onPeerClose?: () => void,
  ) {
    this.allowStun = !!options.stunUrl;
    peer.onLocalDescription((sdp) => {
      try {
        this.description?.resolve(dataOnlyRtcSdp(sdp, this.allowStun));
      } catch {
        this.close();
      }
      this.description = undefined;
    });
    peer.onLocalCandidate((candidate, mid) => {
      try {
        const value = JSON.stringify({ candidate, sdpMid: mid });
        parseRtcCandidate(value, this.allowStun);
        this.count++;
        this.bytes += value.length;
        if (this.count > 256 || this.bytes > 512 * 1024) return this.close();
        for (const listener of this.candidates) listener(value);
      } catch {
        this.close();
      }
    });
    peer.onDataChannel((channel) => {
      if (
        options.role !== "responder" ||
        this.channel ||
        channel.getLabel() !== "pibot-link" ||
        channel.getProtocol()
      ) {
        this.close();
        channel.close();
        return;
      }
      this.attach(channel);
    });
    const state = (event: string, value: string) => {
      const parsed = RtcStateSchema.safeParse({ event, state: value });
      if (parsed.success) options.onDiagnostic?.(parsed.data);
      if (["failed", "disconnected", "closed"].includes(value)) this.close();
    };
    peer.onStateChange((value) => state("connection", value));
    peer.onIceStateChange((value) => state("ice", value));
    peer.onGatheringStateChange((value) => state("gathering", value));
    options.signal.addEventListener("abort", this.abort, { once: true });
    if (options.signal.aborted) this.close();
  }
  private abort = () => this.close();
  private attach(channel: DataChannel) {
    const attached = new RunnerChannel(channel);
    this.channel = attached;
    this.channel.addEventListener("open", () => {
      this.options.onDiagnostic?.({ event: "channel", state: "open" });
      for (const waiter of this.waiters) waiter.resolve(attached);
      this.waiters.clear();
    });
    this.channel.addEventListener("close", () => this.close());
    return this.channel;
  }
  createDataChannel() {
    return this.attach(this.peer.createDataChannel("pibot-link", { unordered: false }));
  }
  async waitDataChannel(channel?: DataChannelLike): Promise<DataChannelLike> {
    if (this.closed) throw new Error("runner_rtc_closed");
    const current = channel ?? this.channel;
    if (current?.readyState === "open") return current;
    return new Promise((resolve, reject) => this.waiters.add({ resolve, reject }));
  }
  private local(type: "offer" | "answer") {
    return new Promise<string>((resolve, reject) => {
      if (this.closed || this.description) return reject(new Error("runner_rtc_closed"));
      this.description = { resolve, reject };
      try {
        this.peer.setLocalDescription(type);
      } catch {
        this.close();
      }
    });
  }
  createOffer() {
    return this.local("offer");
  }
  async acceptOffer(sdp: string) {
    this.peer.setRemoteDescription(dataOnlyRtcSdp(sdp, this.allowStun), "offer");
    return this.local("answer");
  }
  async acceptAnswer(sdp: string) {
    this.peer.setRemoteDescription(dataOnlyRtcSdp(sdp, this.allowStun), "answer");
  }
  async addCandidate(value: string) {
    const candidate = parseRtcCandidate(value, this.allowStun);
    if (candidate) this.peer.addRemoteCandidate(candidate.candidate, candidate.sdpMid ?? "0");
  }
  onCandidate(listener: (candidate: string) => void) {
    this.candidates.add(listener);
    return () => {
      this.candidates.delete(listener);
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.options.signal.removeEventListener("abort", this.abort);
    this.description?.reject(new Error("runner_rtc_closed"));
    this.description = undefined;
    for (const waiter of this.waiters) waiter.reject(new Error("runner_rtc_closed"));
    this.waiters.clear();
    this.candidates.clear();
    this.onPeerClose?.();
    this.channel?.close();
    this.peer.close();
  }
}
