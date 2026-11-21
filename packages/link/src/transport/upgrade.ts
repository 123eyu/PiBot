import type { Port } from "@pibot/protocol-base";
import { z } from "zod";
import { LinkError, MAX_FRAME, type RandomBytes, utf8 } from "../core/bytes.ts";
import type { NoiseChannel } from "../noise/channel.ts";
import { bufferChannel } from "./buffer-channel.ts";
import {
  type DataChannelLike,
  type DataChannelTransportOptions,
  dataChannelTransport,
} from "./datachannel.ts";
import { establishNoise } from "./handshake.ts";
import type { BinaryTransport } from "./port.ts";
import {
  DirectConnectionError,
  type DirectDiagnosticSink,
  type DirectFailure,
  type DirectStageSchema,
  directDiagnostics,
  emitDirectDiagnostic,
  type RtcState,
} from "./rtc-diagnostics.ts";
import type { PathStats } from "./rtc-stats.ts";

export const DIRECT_SIGNAL_METHODS = [
  "link.direct.hint",
  "link.direct.offer",
  "link.direct.answer",
  "link.direct.candidate",
  "link.direct.ready",
] as const;
export type DirectSignalMethod = (typeof DIRECT_SIGNAL_METHODS)[number];
export type DirectRole = "initiator" | "responder";

const DIRECT_METHODS = new Set<string>(DIRECT_SIGNAL_METHODS);
const DEFAULT_SDP_LIMIT = 128 * 1024;
const DEFAULT_CANDIDATE_LIMIT = 16 * 1024;
const MAX_CANDIDATES = 256;
const MAX_CANDIDATE_BYTES = 512 * 1024;
const MAX_CANDIDATE_LIMIT = 128 * 1024;
const MAX_NEGOTIATION_TIMEOUT = 120_000;
const DIRECT_PROLOGUE = utf8("pibot-link-direct-v1");

const ValueParamsSchema = z.strictObject({ value: z.string() });
const HintSchema = z.enum([
  "peer_vpn_active",
  "local_tun_proxy",
  "different_subnet",
  "local_mdns_only",
]);
const DirectSignalSchema = z.discriminatedUnion("method", [
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal("link.direct.hint"),
    params: z.strictObject({ value: HintSchema }),
  }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal("link.direct.offer"),
    params: ValueParamsSchema,
  }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal("link.direct.answer"),
    params: ValueParamsSchema,
  }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal("link.direct.candidate"),
    params: ValueParamsSchema,
  }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal("link.direct.ready"),
    params: z.strictObject({}),
  }),
]);
const MethodProbeSchema = z.object({ method: z.string() });

export interface RtcPeerLike {
  createDataChannel(): DataChannelLike;
  waitDataChannel(channel?: DataChannelLike): Promise<DataChannelLike>;
  createOffer(): Promise<string>;
  acceptOffer(offer: string): Promise<string>;
  acceptAnswer(answer: string): Promise<void>;
  addCandidate(candidate: string): Promise<void>;
  onCandidate(listener: (candidate: string) => void): () => void;
  close(): void;
  /** Selected ICE candidate pair classification; absent on old adapters. */
  selectedPathKind?(): Promise<"lan" | "punched" | "relay" | "unknown">;
  /** The selected pair with its round trip and how many pairs are still checked (rtc-stats.ts). */
  pathStats?(): Promise<PathStats>;
  /** STUN was on and no server-reflexive candidate was gathered; absent on other adapters. */
  missingReflexive?(): boolean;
}
/** A negotiated channel and what it runs on; `pathStats` asks again later (diagnostics, re-probe). */
export type DirectChannel = DataChannelLike & {
  pathKind?: "lan" | "punched" | "relay" | "unknown";
  pathStats?(): Promise<PathStats | undefined>;
};

export type RtcPeerFactory = (options: {
  role: DirectRole;
  signal: AbortSignal;
  /** Omitted means host-only. The application validates and authorizes the STUN authority. */
  stunUrl?: string;
  onDiagnostic?(event: RtcState): void;
}) => RtcPeerLike | Promise<RtcPeerLike>;

export interface DirectSignalingOptions {
  timeoutMs?: number;
  maxSdpBytes?: number;
  maxCandidateBytes?: number;
}

export interface NegotiateDirectOptions {
  /** Computes a fixed local explanation from existing authenticated host candidates. */
  failureHint?(
    remoteHosts: readonly string[],
  ): "peer_vpn_active" | "local_tun_proxy" | "different_subnet" | undefined;
  port: Port;
  signaling?: DirectSignalingOptions;
  createPeer: RtcPeerFactory;
  role: DirectRole;
  signal: AbortSignal;
  onDiagnostic?: DirectDiagnosticSink;
}

type DirectSignal = z.output<typeof DirectSignalSchema>;

function parseSignal(message: unknown): DirectSignal | undefined {
  const probe = MethodProbeSchema.safeParse(message);
  if (!probe.success || !DIRECT_METHODS.has(probe.data.method)) return;
  const parsed = DirectSignalSchema.safeParse(message);
  if (!parsed.success) throw new LinkError("invalid_direct_signal");
  return parsed.data;
}

function sized(value: string, maximum: number, allowEmpty = false) {
  const length = utf8(value).length;
  if ((!allowEmpty && length === 0) || length > maximum)
    throw new LinkError("invalid_direct_signal");
  return length;
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum)
    throw new LinkError("invalid_direct_options");
  return selected;
}

function closePeer(peer: RtcPeerLike) {
  try {
    peer.close();
  } catch {
    /* Cleanup failure cannot revive or retain a logically retired negotiation. */
  }
}

function abortable<T>(
  start: () => T | PromiseLike<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LinkError("direct_negotiation_failed"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    let pending: T | PromiseLike<T>;
    try {
      pending = start();
    } catch {
      settled = true;
      cleanup();
      reject(new LinkError("direct_negotiation_failed"));
      return;
    }
    Promise.resolve(pending).then(
      (value) => {
        if (settled) {
          late?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new LinkError("direct_negotiation_failed"));
      },
    );
  });
}

/**
 * Exchanges reserved notifications over an existing encrypted Port.
 * The caller serializes attempts; one Port must not negotiate two direct sessions concurrently.
 */
export async function negotiateDirect(options: NegotiateDirectOptions): Promise<DirectChannel> {
  if (options.signal.aborted) throw new LinkError("direct_negotiation_failed");
  const timeoutMs = boundedOption(
    options.signaling?.timeoutMs,
    20_000,
    100,
    MAX_NEGOTIATION_TIMEOUT,
  );
  const sdpLimit = boundedOption(options.signaling?.maxSdpBytes, DEFAULT_SDP_LIMIT, 1, MAX_FRAME);
  const candidateLimit = boundedOption(
    options.signaling?.maxCandidateBytes,
    DEFAULT_CANDIDATE_LIMIT,
    1,
    MAX_CANDIDATE_LIMIT,
  );
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const diagnostics = directDiagnostics(options.onDiagnostic);
  let stage: z.infer<typeof DirectStageSchema> = "setup";
  let peer: RtcPeerLike;
  try {
    peer = await abortable(
      () => options.createPeer({ role: options.role, signal, onDiagnostic: diagnostics.state }),
      signal,
      closePeer,
    );
  } catch {
    clearTimeout(timer);
    if (!options.signal.aborted) diagnostics.failure(stage, "rtc_unavailable");
    diagnostics.finish();
    throw new DirectConnectionError("rtc_unavailable");
  }
  let channel: DataChannelLike | undefined;
  stage = "offer";
  let settled = false;
  let remoteReady = false;
  let localReady = false;
  let descriptionAccepted = false;
  let offerReceived = false;
  let answerReceived = false;
  let incomingCandidates = 0;
  let signalingSent = 0;
  let signalingReceived = 0;
  let incomingCandidateBytes = 0;
  let outgoingCandidates = 0;
  let outgoingCandidateBytes = 0;
  const pendingCandidates: string[] = [];
  const remoteHosts = new Set<string>();
  let peerHint: DirectFailure | undefined;
  let resolveResult: (value: DirectChannel) => void = () => {};
  let rejectResult: (error: LinkError) => void = () => {};
  const result = new Promise<DirectChannel>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let offPort = () => {};
  let offCandidate = () => {};

  const cleanupNegotiation = () => {
    clearTimeout(timer);
    const stopPort = offPort;
    const stopCandidate = offCandidate;
    offPort = () => {};
    offCandidate = () => {};
    try {
      stopPort();
    } catch {
      /* A broken adapter cannot prevent the peer from being retired. */
    }
    try {
      stopCandidate();
    } catch {
      /* Candidate cleanup is independent from encrypted Port cleanup. */
    }
  };
  const fail = () => {
    if (settled) return;
    const localHint = options.failureHint?.([...remoteHosts]);
    const reason = localHint ?? peerHint ?? diagnostics.reason(timeout.signal.aborted, stage);
    if (localHint && !options.signal.aborted) {
      try {
        post("link.direct.hint", localHint);
      } catch {
        /* The authenticated path may already be retired. */
      }
    }
    if (!options.signal.aborted) diagnostics.failure(stage, reason);
    settled = true;
    cleanupNegotiation();
    signal.removeEventListener("abort", fail);
    // Read before close: the adapter's answer describes this attempt's gathering.
    let retrySoon = false;
    try {
      retrySoon = peer.missingReflexive?.() === true;
    } catch {
      /* A diagnostic read cannot change how the attempt ends. */
    }
    closePeer(peer);
    diagnostics.finish();
    rejectResult(new DirectConnectionError(reason, retrySoon));
  };
  const post = (method: DirectSignalMethod, value?: string) => {
    if (signal.aborted) throw new LinkError("direct_negotiation_failed");
    options.port.post({
      jsonrpc: "2.0",
      method,
      params: value === undefined ? {} : { value },
    });
    signalingSent++;
    emitDirectDiagnostic(options.onDiagnostic, {
      event: "signaling",
      sent: signalingSent,
      received: signalingReceived,
    });
  };
  const finish = async () => {
    if (settled || !localReady || !remoteReady || !channel) return;
    settled = true;
    cleanupNegotiation();
    signal.removeEventListener("abort", fail);
    const negotiated = channel;
    let retired = false;
    const retire = () => {
      if (retired) return;
      retired = true;
      negotiated.removeEventListener("close", retire);
      negotiated.removeEventListener("error", retire);
      signal.removeEventListener("abort", retire);
      closePeer(peer);
    };
    negotiated.addEventListener("close", retire);
    negotiated.addEventListener("error", retire);
    signal.addEventListener("abort", retire, { once: true });
    if (signal.aborted || negotiated.readyState !== "open") {
      retire();
      rejectResult(new LinkError("direct_negotiation_failed"));
      return;
    }
    // Diagnostics only: a slow or failing getStats must never hold up or fail the direct path.
    const stats = peer.pathStats
      ? () => {
          if (retired) return Promise.resolve(undefined);
          let timer: ReturnType<typeof setTimeout> | undefined;
          return Promise.race([
            (peer.pathStats?.() ?? Promise.resolve(undefined)).catch(() => undefined),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), 1000);
            }),
          ]).finally(() => clearTimeout(timer));
        }
      : undefined;
    const kind = stats
      ? ((await stats())?.kind ?? "unknown")
      : await Promise.race([
          peer.selectedPathKind?.().catch(() => "unknown" as const) ??
            Promise.resolve("unknown" as const),
          new Promise<"unknown">((resolve) => setTimeout(() => resolve("unknown"), 1000)),
        ]);
    resolveResult(
      Object.assign(negotiated, { pathKind: kind, ...(stats ? { pathStats: stats } : {}) }),
    );
    diagnostics.finish();
  };
  const setLocalReady = async (value?: DataChannelLike) => {
    stage = "channel";
    const opened = await abortable(() => peer.waitDataChannel(value), signal);
    if (signal.aborted || opened.readyState !== "open")
      throw new LinkError("direct_channel_not_open");
    channel = bufferChannel(opened);
    localReady = true;
    stage = "ready";
    post("link.direct.ready");
    finish();
  };
  const acceptCandidate = async (value: string) => {
    try {
      await abortable(() => peer.addCandidate(value), signal);
    } catch (error) {
      if (!signal.aborted) stage = "candidate";
      throw error;
    }
  };
  const flushCandidates = async () => {
    while (pendingCandidates.length) await acceptCandidate(pendingCandidates.shift() as string);
  };
  const addCandidate = async (candidate: string) => {
    const bytes = sized(candidate, candidateLimit, true);
    incomingCandidates++;
    incomingCandidateBytes += bytes;
    if (incomingCandidates > MAX_CANDIDATES || incomingCandidateBytes > MAX_CANDIDATE_BYTES)
      throw new LinkError("invalid_direct_signal");
    diagnostics.wireCandidate("remote", candidate);
    try {
      const wire = JSON.parse(candidate) as { candidate?: unknown };
      if (typeof wire.candidate === "string") {
        const fields = wire.candidate.trim().split(/\s+/);
        if (fields[6] === "typ" && fields[7] === "host" && fields[4] && remoteHosts.size < 256)
          remoteHosts.add(fields[4]);
      }
    } catch {
      /* Wire validation remains owned by the RTC adapter. */
    }
    if (!descriptionAccepted) pendingCandidates.push(candidate);
    else await acceptCandidate(candidate);
  };
  const sendCandidate = (candidate: string) => {
    const bytes = sized(candidate, candidateLimit, true);
    outgoingCandidates++;
    outgoingCandidateBytes += bytes;
    if (outgoingCandidates > MAX_CANDIDATES || outgoingCandidateBytes > MAX_CANDIDATE_BYTES)
      throw new LinkError("invalid_direct_signal");
    diagnostics.wireCandidate("local", candidate);
    post("link.direct.candidate", candidate);
  };
  const handle = async (message: DirectSignal) => {
    if (settled) return;
    signalingReceived++;
    emitDirectDiagnostic(options.onDiagnostic, {
      event: "signaling",
      sent: signalingSent,
      received: signalingReceived,
    });
    switch (message.method) {
      case "link.direct.hint": {
        peerHint = message.params.value;
        return;
      }
      case "link.direct.offer": {
        if (options.role !== "responder" || offerReceived)
          throw new LinkError("invalid_direct_signal");
        offerReceived = true;
        const hint = options.failureHint?.([]);
        if (hint) post("link.direct.hint", hint);
        sized(message.params.value, sdpLimit);
        stage = "answer";
        diagnostics.sdp("remote", message.params.value);
        const answer = await abortable(() => peer.acceptOffer(message.params.value), signal);
        sized(answer, sdpLimit);
        diagnostics.sdp("local", answer);
        descriptionAccepted = true;
        await flushCandidates();
        post("link.direct.answer", answer);
        // Trickle ICE must keep flowing while opening the channel depends on it.
        void setLocalReady().catch(fail);
        return;
      }
      case "link.direct.answer": {
        if (options.role !== "initiator" || answerReceived)
          throw new LinkError("invalid_direct_signal");
        answerReceived = true;
        sized(message.params.value, sdpLimit);
        stage = "answer";
        diagnostics.sdp("remote", message.params.value);
        await abortable(() => peer.acceptAnswer(message.params.value), signal);
        descriptionAccepted = true;
        await flushCandidates();
        void setLocalReady(channel).catch(fail);
        return;
      }
      case "link.direct.candidate": {
        await addCandidate(message.params.value);
        return;
      }
      case "link.direct.ready": {
        if (remoteReady) throw new LinkError("invalid_direct_signal");
        remoteReady = true;
        finish();
      }
    }
  };
  let tail = Promise.resolve();
  try {
    offPort = options.port.onMessage((message) => {
      try {
        const parsed = parseSignal(message);
        if (!parsed) return;
        tail = tail.then(() => handle(parsed)).catch(fail);
      } catch {
        fail();
      }
    });
    if (!settled)
      offCandidate = peer.onCandidate((candidate) => {
        try {
          sendCandidate(candidate);
        } catch {
          fail();
        }
      });
    if (settled) cleanupNegotiation();
  } catch {
    fail();
  }
  if (!settled) signal.addEventListener("abort", fail, { once: true });
  if (!settled && signal.aborted) fail();
  else if (!settled && options.role === "initiator") {
    try {
      channel = peer.createDataChannel();
      stage = "offer";
      const hint = options.failureHint?.([]);
      if (hint) post("link.direct.hint", hint);
      const offer = await abortable(() => peer.createOffer(), signal);
      sized(offer, sdpLimit);
      diagnostics.sdp("local", offer);
      post("link.direct.offer", offer);
    } catch {
      fail();
    }
  }

  return result;
}

export interface EstablishDirectNoiseOptions {
  role: DirectRole;
  staticSecret: Uint8Array;
  remoteStatic: Uint8Array;
  random: RandomBytes;
  signal: AbortSignal;
  timeoutMs?: number;
  transport?: Omit<DataChannelTransportOptions, "signal">;
}

export async function establishDirectNoise(
  dataChannel: DirectChannel,
  options: EstablishDirectNoiseOptions,
): Promise<{
  transport: BinaryTransport;
  channel: NoiseChannel;
  pathKind?: "lan" | "punched" | "relay" | "unknown";
  pathStats?(): Promise<PathStats | undefined>;
}> {
  const transport = dataChannelTransport(dataChannel, {
    ...options.transport,
    signal: options.signal,
  });
  const channel = await establishNoise(transport, {
    role: options.role,
    staticSecret: options.staticSecret,
    remoteStatic: options.remoteStatic,
    random: options.random,
    prologue: DIRECT_PROLOGUE,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return {
    transport,
    channel,
    pathKind: dataChannel.pathKind,
    ...(dataChannel.pathStats ? { pathStats: dataChannel.pathStats } : {}),
  };
}
