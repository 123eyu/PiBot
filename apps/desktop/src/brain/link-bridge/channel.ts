import type { DataChannelEvent, DataChannelLike } from "@pibot/link";
import {
  BRIDGE_BUFFER,
  BRIDGE_FRAGMENT,
  BRIDGE_FRAMES,
  BRIDGE_SEND_BUFFER,
  type BridgeCommand,
  type BridgeEvent,
} from "../../link-bridge/protocol.ts";

export class BridgeDataChannel implements DataChannelLike {
  readyState: DataChannelLike["readyState"] = "connecting";
  private remoteBuffered = 0;
  private sentBytes = 0;
  private ackedBytes = 0;
  private receivedBytes = 0;
  private receiveSequence = 0;
  private sendSequence = 0;
  private ackedSequence = 0;
  private threshold = 0;
  private listeners = new Map<string, Set<(event: DataChannelEvent) => void>>();
  get binaryType() {
    return "arraybuffer";
  }
  set binaryType(value: string) {
    if (value !== "arraybuffer") throw new Error("invalid_bridge_binary_type");
  }
  constructor(
    private readonly peer: string,
    private readonly post: (command: BridgeCommand) => void,
    private readonly retire: (failed: boolean) => void,
  ) {}
  get bufferedAmount() {
    // Include bytes queued in IPC until the renderer acknowledges the native send.
    return this.remoteBuffered + this.sentBytes - this.ackedBytes;
  }
  get bufferedAmountLowThreshold() {
    return this.threshold;
  }
  set bufferedAmountLowThreshold(value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value > BRIDGE_BUFFER)
      throw new Error("invalid_bridge_threshold");
    this.threshold = value;
    this.post({ kind: "threshold", peer: this.peer, value });
  }
  send(data: ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("transport_closed");
    if (data.byteLength === 0 || data.byteLength > BRIDGE_FRAGMENT)
      throw new Error("invalid_frame");
    if (
      this.bufferedAmount + data.byteLength > BRIDGE_SEND_BUFFER ||
      this.sendSequence - this.ackedSequence >= BRIDGE_FRAMES
    )
      throw new Error("transport_capacity");
    this.sentBytes += data.byteLength;
    try {
      this.post({
        kind: "send",
        peer: this.peer,
        sequence: this.sendSequence++,
        frame: new Uint8Array(data),
      });
    } catch {
      this.retire(true);
      throw new Error("transport_closed");
    }
  }
  close() {
    this.retire(false);
  }
  addEventListener(type: string, listener: (event: DataChannelEvent) => void) {
    let values = this.listeners.get(type);
    if (!values) {
      values = new Set();
      this.listeners.set(type, values);
    }
    values.add(listener);
  }
  removeEventListener(type: string, listener: (event: DataChannelEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  private emit(type: string, data?: unknown) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      try {
        listener({ type, ...(data === undefined ? {} : { data }) });
      } catch {
        this.retire(true);
        return;
      }
    }
  }
  receive(event: BridgeEvent) {
    if (this.readyState === "closed") return;
    if (event.kind === "state") {
      if (event.state === "closed" || event.state === "closing") return this.retire(false);
      if (event.ackedBytes < this.ackedBytes || event.ackedBytes > this.sentBytes)
        return this.retire(true);
      if (event.ackedSequence < this.ackedSequence || event.ackedSequence > this.sendSequence)
        return this.retire(true);
      const previous = this.bufferedAmount;
      const opening = this.readyState !== "open" && event.state === "open";
      this.remoteBuffered = event.bufferedAmount;
      this.ackedBytes = event.ackedBytes;
      this.ackedSequence = event.ackedSequence;
      this.readyState = event.state;
      if (opening) this.emit("open");
      if (previous > this.threshold && this.bufferedAmount <= this.threshold)
        this.emit("bufferedamountlow");
    } else if (event.kind === "frame") {
      if (event.sequence !== this.receiveSequence++ || this.readyState !== "open")
        return this.retire(true);
      this.receivedBytes += event.frame.byteLength;
      try {
        this.post({
          kind: "received",
          peer: this.peer,
          bytes: this.receivedBytes,
          sequence: this.receiveSequence,
        });
      } catch {
        return this.retire(true);
      }
      this.emit("message", event.frame.slice().buffer);
    }
  }
  finish(failed: boolean) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    if (failed) this.emit("error");
    this.emit("close");
    this.listeners.clear();
    this.remoteBuffered = 0;
    this.ackedBytes = this.sentBytes;
  }
}
