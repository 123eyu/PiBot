import {
  type DataChannelLike,
  dataOnlyRtcSdp,
  ICE_DISCONNECTED_GRACE_MS,
  iceVerdict,
  type PathStats,
  parseRtcCandidate,
  type RtcPeerFactory,
  type RtcPeerLike,
  type RtcState,
  RtcStateSchema,
  rtcCandidateType,
  rtcPathStats,
} from "@pibot/link";
import { StunUrlSchema } from "@pibot/protocol";
import { RTCPeerConnection } from "react-native-webrtc";
import { z } from "zod";
import { MobileDataChannel } from "./rtc-channel.ts";

/**
 * With STUN on, the offer waits this long at most for the phone's public (server-reflexive)
 * candidate or the end of gathering. The computer's ICE checks start when the offer arrives and
 * give up about 15 s later, so a public candidate that comes late leaves less time to pair; after
 * the wait the offer goes with what there is and later candidates still trickle.
 */
const REFLEXIVE_WAIT_MS = 3000;

const OfferSchema = z.object({
  type: z.literal("offer"),
  sdp: z
    .string()
    .min(1)
    .max(128 * 1024),
});

class MobileRtcPeer implements RtcPeerLike {
  private readonly rtc: RTCPeerConnection;
  private readonly allowStun: boolean;
  private channel?: MobileDataChannel;
  private closed = false;
  private readonly candidates = new Set<(value: string) => void>();
  private candidateCount = 0;
  private candidateBytes = 0;
  /** A server-reflexive candidate was gathered (only possible with STUN on). */
  private reflexive = false;
  private gathered = false;
  private readonly gatherWaits = new Set<() => void>();
  private readonly waiting = new Set<{ reject(error: Error): void }>();
  private disconnected?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly signal: AbortSignal,
    stunUrl?: string,
    private readonly onDiagnostic?: (event: RtcState) => void,
  ) {
    this.allowStun = stunUrl !== undefined;
    this.rtc = new RTCPeerConnection({
      iceServers: stunUrl ? [{ urls: StunUrlSchema.parse(stunUrl) }] : [],
      iceCandidatePoolSize: 0,
    });
    this.rtc.addEventListener("icecandidate", this.candidate);
    this.rtc.addEventListener("iceconnectionstatechange", this.state);
    this.rtc.addEventListener("connectionstatechange", this.state);
    this.rtc.addEventListener("icegatheringstatechange", this.gathering);
    this.rtc.addEventListener("datachannel", this.unexpectedChannel);
    signal.addEventListener("abort", this.close, { once: true });
    if (signal.aborted) this.close();
  }
  private candidate = (event: { candidate: { toJSON(): unknown } | null }) => {
    if (this.closed) return;
    const value = event.candidate ? JSON.stringify(event.candidate.toJSON()) : "";
    let parsed: ReturnType<typeof parseRtcCandidate>;
    try {
      parsed = parseRtcCandidate(value, this.allowStun);
    } catch {
      return this.close();
    }
    this.candidateCount++;
    this.candidateBytes += value.length;
    if (value.length > 16 * 1024 || this.candidateCount > 256 || this.candidateBytes > 512 * 1024)
      return this.close();
    // An empty value is the end of gathering (react-native-webrtc sends it on "complete").
    if (!parsed) this.gathered = true;
    else if (rtcCandidateType(parsed.candidate) === "srflx") this.reflexive = true;
    if (this.reflexive || this.gathered) for (const wake of [...this.gatherWaits]) wake();
    for (const listener of this.candidates) listener(value);
  };
  private state = () => {
    if (this.closed) return;
    this.diagnose("ice", this.rtc.iceConnectionState);
    this.diagnose("connection", this.rtc.connectionState);
    const verdict = iceVerdict(this.rtc.iceConnectionState, this.rtc.connectionState);
    if (verdict === "close") return this.close();
    if (verdict === "ok") {
      clearTimeout(this.disconnected);
      this.disconnected = undefined;
    } else this.disconnected ??= setTimeout(this.close, ICE_DISCONNECTED_GRACE_MS);
  };
  private readonly states = new Map<string, string>();
  private diagnose(event: string, state: string) {
    if (this.closed || this.states.get(event) === state) return;
    const parsed = RtcStateSchema.safeParse({ event, state });
    if (!parsed.success) return;
    this.states.set(event, state);
    this.onDiagnostic?.(parsed.data);
  }
  private gathering = () => this.diagnose("gathering", this.rtc.iceGatheringState);
  private unexpectedChannel = (event: { channel: { close(): void } }) => {
    event.channel.close();
    this.close();
  };
  private active() {
    if (this.closed) throw new Error("rtc_peer_closed");
    this.signal.throwIfAborted();
  }
  createDataChannel() {
    this.active();
    if (this.channel) throw new Error("rtc_channel_exists");
    this.channel = new MobileDataChannel(
      this.rtc.createDataChannel("pibot-link", { ordered: true }),
      this.close,
      (state) => this.diagnose("channel", state),
    );
    return this.channel;
  }
  async waitDataChannel(channel?: DataChannelLike): Promise<DataChannelLike> {
    this.active();
    const current = this.channel;
    if (!current || (channel && channel !== current)) throw new Error("invalid_rtc_channel");
    if (current.readyState === "open") return current;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        current.removeEventListener("open", open);
        current.removeEventListener("close", fail);
        current.removeEventListener("error", fail);
        this.waiting.delete(wait);
      };
      const wait = {
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const open = () => {
        cleanup();
        resolve();
      };
      const fail = () => wait.reject(new Error("rtc_channel_closed"));
      const timer = setTimeout(() => {
        fail();
        this.close();
      }, 20_000);
      this.waiting.add(wait);
      current.addEventListener("open", open);
      current.addEventListener("close", fail);
      current.addEventListener("error", fail);
      if (current.readyState === "open") open();
      else if (current.readyState !== "connecting") fail();
    });
    this.active();
    return current;
  }
  async createOffer() {
    this.active();
    if (!this.channel) throw new Error("rtc_channel_missing");
    const offer = OfferSchema.parse(await this.rtc.createOffer());
    this.active();
    await this.rtc.setLocalDescription(offer);
    this.active();
    if (this.allowStun) await this.reflexiveOrGathered();
    this.active();
    return dataOnlyRtcSdp(this.rtc.localDescription?.sdp ?? "", this.allowStun);
  }
  /** Resolves on the first public candidate, the end of gathering, the deadline or close. */
  private reflexiveOrGathered() {
    if (this.reflexive || this.gathered) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.gatherWaits.delete(done);
        resolve();
      };
      const timer = setTimeout(done, REFLEXIVE_WAIT_MS);
      this.gatherWaits.add(done);
    });
  }
  /**
   * STUN was on and no public candidate came. Phone test 2026-11-16: right after the computer
   * restarted, the phone's attempts carried host candidates only for minutes (its STUN answer
   * never came, and gathering never finished) and failed across subnets; the first one with a
   * public candidate paired at once. Such a failure is worth retrying soon.
   */
  missingReflexive() {
    return this.allowStun && !this.reflexive;
  }
  async acceptOffer(): Promise<string> {
    throw new Error("rtc_initiator_only");
  }
  async acceptAnswer(answer: string) {
    this.active();
    await this.rtc.setRemoteDescription({
      type: "answer",
      sdp: dataOnlyRtcSdp(answer, this.allowStun),
    });
    this.active();
  }
  async pathStats(): Promise<PathStats> {
    this.active();
    return rtcPathStats(await this.rtc.getStats());
  }
  async selectedPathKind(): Promise<"lan" | "punched" | "relay" | "unknown"> {
    return (await this.pathStats()).kind;
  }

  async addCandidate(candidate: string) {
    this.active();
    if (candidate.length > 16 * 1024) throw new Error("invalid_rtc_candidate");
    // react-native-webrtc treats an absent candidate as end-of-gathering (a native no-op).
    const value = parseRtcCandidate(candidate, this.allowStun);
    await this.rtc.addIceCandidate(value);
    this.active();
  }
  onCandidate(listener: (value: string) => void) {
    this.active();
    this.candidates.add(listener);
    return () => {
      this.candidates.delete(listener);
    };
  }
  close = () => {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.disconnected);
    this.signal.removeEventListener("abort", this.close);
    this.rtc.removeEventListener("icecandidate", this.candidate);
    this.rtc.removeEventListener("iceconnectionstatechange", this.state);
    this.rtc.removeEventListener("connectionstatechange", this.state);
    this.rtc.removeEventListener("icegatheringstatechange", this.gathering);
    this.rtc.removeEventListener("datachannel", this.unexpectedChannel);
    for (const wait of [...this.waiting]) wait.reject(new Error("rtc_peer_closed"));
    // createOffer checks `active()` after the wait, so a woken offer stops there.
    for (const wake of [...this.gatherWaits]) wake();
    this.candidates.clear();
    this.states.clear();
    try {
      this.channel?.close();
    } finally {
      this.rtc.close();
    }
  };
}

export const createNativeMobileRtcPeer: RtcPeerFactory = ({
  role,
  signal,
  stunUrl,
  onDiagnostic,
}) => {
  if (role !== "initiator") throw new Error("rtc_initiator_only");
  signal.throwIfAborted();
  return new MobileRtcPeer(signal, stunUrl, onDiagnostic);
};
