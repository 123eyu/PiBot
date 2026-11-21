import {
  dataOnlyRtcSdp,
  ICE_DISCONNECTED_GRACE_MS,
  iceVerdict,
  parseRtcCandidate,
  RtcStateSchema,
  rtcPathStats,
} from "@pibot/link";
import {
  BRIDGE_BUFFER,
  BRIDGE_FRAGMENT,
  BRIDGE_FRAMES,
  BRIDGE_SEND_BUFFER,
  type BridgeEvent,
  type BridgeOperation,
} from "../../link-bridge/protocol.ts";

export class RendererRtcPeer {
  private readonly rtc: RTCPeerConnection;
  private readonly allowStun: boolean;
  private channel?: RTCDataChannel;
  private closed = false;
  private ackedBytes = 0;
  private sentSequence = 0;
  private receiveSequence = 0;
  private deliveredBytes = 0;
  private receivedBytes = 0;
  private receivedSequence = 0;
  private candidateCount = 0;
  private candidateBytes = 0;
  private sample?: ReturnType<typeof setTimeout>;
  private lastState = "";
  private disconnected?: ReturnType<typeof setTimeout>;
  private waiting = new Set<{ resolve(): void; reject(error: Error): void }>();
  constructor(
    private readonly id: string,
    private readonly role: "initiator" | "responder",
    private readonly post: (event: BridgeEvent) => void,
    private readonly retire: (failed: boolean) => void,
    stunUrl?: string,
  ) {
    this.allowStun = stunUrl !== undefined;
    this.rtc = new RTCPeerConnection({
      iceServers: stunUrl ? [{ urls: stunUrl }] : [],
      iceCandidatePoolSize: 0,
    });
    this.rtc.onicecandidate = (event) => {
      const value = event.candidate ? JSON.stringify(event.candidate.toJSON()) : "";
      try {
        parseRtcCandidate(value, this.allowStun);
      } catch {
        return this.retire(true);
      }
      this.candidateCount++;
      this.candidateBytes += value.length;
      if (value.length > 16 * 1024 || this.candidateCount > 256 || this.candidateBytes > 512 * 1024)
        return this.retire(true);
      this.post({ kind: "candidate", peer: id, value });
    };
    this.rtc.ondatachannel = (event) => {
      if (role !== "responder" || this.channel) {
        event.channel.close();
        this.retire(true);
        return;
      }
      this.attach(event.channel);
    };
    const state = () => {
      this.diagnose("ice", this.rtc.iceConnectionState);
      this.diagnose("connection", this.rtc.connectionState);
      const verdict = iceVerdict(this.rtc.iceConnectionState, this.rtc.connectionState);
      if (verdict === "close") return this.retire(true);
      if (verdict === "ok") {
        clearTimeout(this.disconnected);
        this.disconnected = undefined;
      } else
        this.disconnected ??= setTimeout(() => {
          if (!this.closed) this.retire(true);
        }, ICE_DISCONNECTED_GRACE_MS);
    };
    this.rtc.oniceconnectionstatechange = state;
    this.rtc.onconnectionstatechange = state;
    this.rtc.onicegatheringstatechange = () =>
      this.diagnose("gathering", this.rtc.iceGatheringState);
  }
  private readonly states = new Map<string, string>();
  private diagnose(event: string, state: string) {
    if (this.closed || this.states.get(event) === state) return;
    const parsed = RtcStateSchema.safeParse({ event, state });
    if (!parsed.success) return;
    this.states.set(event, state);
    this.post({ kind: "diagnostic", peer: this.id, diagnostic: parsed.data });
  }
  private snapshot = () => {
    clearTimeout(this.sample);
    if (this.closed || !this.channel) return;
    if (this.channel.bufferedAmount > BRIDGE_SEND_BUFFER) return this.retire(true);
    const snapshot = `${this.channel.readyState}:${this.channel.bufferedAmount}:${this.ackedBytes}:${this.sentSequence}`;
    if (snapshot !== this.lastState) {
      this.lastState = snapshot;
      this.post({
        kind: "state",
        peer: this.id,
        state: this.channel.readyState,
        bufferedAmount: this.channel.bufferedAmount,
        ackedBytes: this.ackedBytes,
        ackedSequence: this.sentSequence,
      });
    }
    if (this.channel.bufferedAmount > 0) this.sample = setTimeout(this.snapshot, 50);
  };
  private attach(channel: RTCDataChannel) {
    if (
      !channel.ordered ||
      channel.maxPacketLifeTime !== null ||
      channel.maxRetransmits !== null ||
      channel.label !== "pibot-link" ||
      channel.protocol !== ""
    ) {
      channel.close();
      this.retire(true);
      return;
    }
    this.channel = channel;
    this.diagnose("channel", channel.readyState);
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      this.diagnose("channel", "open");
      this.snapshot();
      for (const wait of this.waiting) wait.resolve();
      this.waiting.clear();
    };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (this.closed) return;
      if (
        !(event.data instanceof ArrayBuffer) ||
        event.data.byteLength === 0 ||
        event.data.byteLength > BRIDGE_FRAGMENT
      )
        return this.retire(true);
      this.deliveredBytes += event.data.byteLength;
      if (
        this.deliveredBytes - this.receivedBytes > BRIDGE_BUFFER ||
        this.receiveSequence - this.receivedSequence >= BRIDGE_FRAMES
      )
        return this.retire(true);
      this.post({
        kind: "frame",
        peer: this.id,
        sequence: this.receiveSequence++,
        frame: new Uint8Array(event.data),
      });
    };
    channel.onbufferedamountlow = this.snapshot;
    channel.onclose = () => {
      this.diagnose("channel", "closed");
      this.retire(false);
    };
    channel.onerror = () => {
      this.diagnose("channel", "error");
      this.retire(true);
    };
    this.snapshot();
  }
  async execute(operation: BridgeOperation): Promise<string | undefined> {
    if (this.closed) throw new Error("link_bridge_closed");
    switch (operation.type) {
      case "create":
        throw new Error("invalid_bridge_operation");
      case "channel":
        if (this.role !== "initiator" || this.channel) throw new Error("invalid_bridge_channel");
        this.attach(this.rtc.createDataChannel("pibot-link", { ordered: true }));
        return;
      case "wait":
        if (this.channel?.readyState === "open") return;
        await new Promise<void>((resolve, reject) => this.waiting.add({ resolve, reject }));
        return;
      case "offer": {
        if (this.role !== "initiator" || !this.channel) throw new Error("invalid_bridge_operation");
        await this.rtc.setLocalDescription(await this.rtc.createOffer());
        return this.rtc.localDescription?.sdp;
      }
      case "acceptOffer":
        if (this.role !== "responder") throw new Error("invalid_bridge_operation");
        await this.rtc.setRemoteDescription({
          type: "offer",
          sdp: dataOnlyRtcSdp(operation.sdp, this.allowStun),
        });
        await this.rtc.setLocalDescription(await this.rtc.createAnswer());
        return this.rtc.localDescription?.sdp;
      case "acceptAnswer":
        if (this.role !== "initiator") throw new Error("invalid_bridge_operation");
        await this.rtc.setRemoteDescription({
          type: "answer",
          sdp: dataOnlyRtcSdp(operation.sdp, this.allowStun),
        });
        return;
      case "candidate": {
        const value = parseRtcCandidate(operation.candidate, this.allowStun);
        await this.rtc.addIceCandidate(value);
        return;
      }
      case "pathKind":
        return rtcPathStats(await this.rtc.getStats()).kind;
      case "pathStats":
        return JSON.stringify(rtcPathStats(await this.rtc.getStats()));
    }
  }
  send(sequence: number, frame: Uint8Array) {
    if (
      this.closed ||
      this.channel?.readyState !== "open" ||
      sequence !== this.sentSequence++ ||
      this.channel.bufferedAmount + frame.byteLength > BRIDGE_SEND_BUFFER
    )
      throw new Error("transport_capacity");
    this.channel.send(frame.slice().buffer);
    this.ackedBytes += frame.byteLength;
    this.snapshot();
  }
  received(bytes: number, sequence: number) {
    if (
      bytes < this.receivedBytes ||
      bytes > this.deliveredBytes ||
      sequence < this.receivedSequence ||
      sequence > this.receiveSequence
    )
      throw new Error("invalid_bridge_credit");
    this.receivedBytes = bytes;
    this.receivedSequence = sequence;
  }
  threshold(value: number) {
    if (this.channel) this.channel.bufferedAmountLowThreshold = value;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.sample);
    clearTimeout(this.disconnected);
    for (const wait of this.waiting) wait.reject(new Error("link_bridge_closed"));
    this.waiting.clear();
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onmessage = null;
      this.channel.onbufferedamountlow = null;
      this.channel.onerror = null;
      this.channel.onclose = null;
      this.channel.close();
    }
    this.rtc.onicecandidate = null;
    this.rtc.ondatachannel = null;
    this.rtc.oniceconnectionstatechange = null;
    this.rtc.onconnectionstatechange = null;
    this.rtc.onicegatheringstatechange = null;
    this.states.clear();
    this.rtc.close();
  }
}
