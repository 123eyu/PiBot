import { DATA_CHANNEL_FRAGMENT, type DataChannelEvent, type DataChannelLike } from "@pibot/link";
import type { RTCPeerConnection } from "react-native-webrtc";

type NativeChannel = ReturnType<RTCPeerConnection["createDataChannel"]>;
type Listener = (event: DataChannelEvent) => void;

/** Normalizes the native channel's loose readyState type and releases native subscriptions. */
export class MobileDataChannel implements DataChannelLike {
  private stopped = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly removers: Array<() => void> = [];
  constructor(
    private readonly native: NativeChannel,
    private readonly retirePeer: () => void,
    private readonly diagnostic?: (state: DataChannelLike["readyState"] | "error") => void,
  ) {
    native.binaryType = "arraybuffer";
    this.diagnostic?.(this.readyState);
    const open = () => {
      this.diagnostic?.("open");
      this.emit({ type: "open" });
    };
    const message = (event: { data: unknown }) => {
      if (
        !(event.data instanceof ArrayBuffer) ||
        event.data.byteLength === 0 ||
        event.data.byteLength > DATA_CHANNEL_FRAGMENT
      ) {
        try {
          this.emit({ type: "error" });
        } finally {
          this.close();
        }
        return;
      }
      this.emit({ type: "message", data: event.data });
    };
    const low = () => {
      this.emit({ type: "bufferedamountlow" });
    };
    const error = () => {
      this.diagnostic?.("error");
      try {
        this.emit({ type: "error" });
      } finally {
        this.close();
      }
    };
    const close = () => this.close();
    native.addEventListener("open", open);
    native.addEventListener("message", message);
    native.addEventListener("bufferedamountlow", low);
    native.addEventListener("error", error);
    native.addEventListener("close", close);
    this.removers.push(
      () => native.removeEventListener("open", open),
      () => native.removeEventListener("message", message),
      () => native.removeEventListener("bufferedamountlow", low),
      () => native.removeEventListener("error", error),
      () => native.removeEventListener("close", close),
    );
  }
  get readyState(): DataChannelLike["readyState"] {
    if (this.stopped) return "closed";
    switch (this.native.readyState) {
      case "connecting":
      case "open":
      case "closing":
      case "closed":
        return this.native.readyState;
      default:
        return "closed";
    }
  }
  get bufferedAmount() {
    // send hands each fragment straight to native; this adapter has no local send queue.
    return this.native.bufferedAmount;
  }
  get bufferedAmountLowThreshold() {
    return this.native.bufferedAmountLowThreshold;
  }
  set bufferedAmountLowThreshold(value: number) {
    this.native.bufferedAmountLowThreshold = value;
  }
  get binaryType() {
    return this.native.binaryType;
  }
  set binaryType(value: string) {
    if (value !== "arraybuffer") throw new Error("invalid_rtc_binary_type");
    this.native.binaryType = value;
  }
  send(data: ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("rtc_channel_closed");
    if (data.byteLength === 0 || data.byteLength > DATA_CHANNEL_FRAGMENT)
      throw new Error("invalid_frame");
    try {
      this.native.send(data);
    } catch {
      this.close();
      throw new Error("rtc_send_failed");
    }
  }
  addEventListener(type: string, listener: Listener) {
    if (this.stopped) return;
    let group = this.listeners.get(type);
    if (!group) {
      group = new Set();
      this.listeners.set(type, group);
    }
    group.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    const group = this.listeners.get(type);
    group?.delete(listener);
    if (group?.size === 0) this.listeners.delete(type);
  }
  private emit(event: DataChannelEvent) {
    if (this.stopped && event.type !== "close") return;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
  }
  close() {
    if (this.stopped) return;
    this.diagnostic?.("closed");
    this.stopped = true;
    for (const off of this.removers) off();
    this.removers.length = 0;
    try {
      this.native.close();
    } finally {
      try {
        this.emit({ type: "close" });
      } finally {
        this.listeners.clear();
        this.retirePeer();
      }
    }
  }
}
