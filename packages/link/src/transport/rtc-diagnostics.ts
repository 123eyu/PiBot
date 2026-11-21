import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { base64url, LinkError, utf8 } from "../core/bytes.ts";

export const DirectFailureSchema = z.enum([
  "peer_vpn_active",
  "local_tun_proxy",
  "different_subnet",
  "local_mdns_only",
  "ice_timeout",
  "rtc_unavailable",
  "signaling_failed",
  "negotiation_timeout",
  "no_candidates",
  "ice_failed",
  "channel_failed",
  "noise_failed",
  "switch_failed",
  // The opened path did not answer a small / a large round trip before the switch (path-probe.ts).
  "probe_failed",
  "path_mtu",
]);
export type DirectFailure = z.infer<typeof DirectFailureSchema>;
export const DirectStageSchema = z.enum([
  "setup",
  "offer",
  "answer",
  "candidate",
  "channel",
  "ready",
  "noise",
  "probe",
  "switch",
]);
const counts = z.strictObject({
  host: z.number().int().min(0).max(256),
  mdns: z.number().int().min(0).max(256),
  srflx: z.number().int().min(0).max(256),
  prflx: z.number().int().min(0).max(256),
  relay: z.number().int().min(0).max(256),
  unknown: z.number().int().min(0).max(256),
});
export const RtcStateSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("ice"),
    state: z.enum([
      "new",
      "checking",
      "connected",
      "completed",
      "disconnected",
      "failed",
      "closed",
    ]),
  }),
  z.strictObject({
    event: z.literal("connection"),
    state: z.enum(["new", "connecting", "connected", "disconnected", "failed", "closed"]),
  }),
  z.strictObject({
    event: z.literal("gathering"),
    state: z.enum(["new", "gathering", "complete"]),
  }),
  z.strictObject({
    event: z.literal("channel"),
    state: z.enum(["connecting", "open", "closing", "closed", "error"]),
  }),
]);
export type RtcState = z.infer<typeof RtcStateSchema>;
export const DirectDiagnosticSchema = z.union([
  RtcStateSchema,
  z.strictObject({
    event: z.literal("signaling"),
    sent: z.number().int().min(0).max(512),
    received: z.number().int().min(0).max(512),
  }),
  z.strictObject({ event: z.literal("candidates"), local: counts, remote: counts }),
  // Maintainers 2026-11-12: the path switch timed out waiting for an idle relay; name what kept it busy
  // (request counts and method names only, never parameters).
  z.strictObject({
    event: z.literal("relay_busy"),
    incoming: z.number().int().min(0).max(1000),
    outgoing: z.number().int().min(0).max(1000),
    methods: z.array(z.string().regex(/^[A-Za-z][\w.]{0,63}$/)).max(8),
  }),
  z.strictObject({
    event: z.literal("failure"),
    stage: DirectStageSchema,
    reason: DirectFailureSchema,
  }),
]);
export type DirectDiagnostic = z.infer<typeof DirectDiagnosticSchema>;
export type DirectDiagnosticSink = (event: DirectDiagnostic) => void;

export function emitDirectDiagnostic(
  sink: DirectDiagnosticSink | undefined,
  event: DirectDiagnostic,
) {
  const parsed = DirectDiagnosticSchema.safeParse(event);
  if (!parsed.success) return;
  try {
    sink?.(parsed.data);
  } catch {
    /* Local diagnostics cannot break the transport. */
  }
}

export class DirectConnectionError extends LinkError {
  constructor(
    readonly reason: DirectFailure,
    /**
     * This side had STUN on and gathered no public candidate, so the attempt said little about
     * the path; PathSession retries such a failure at its shortest delay (bounded).
     */
    readonly retrySoon = false,
  ) {
    super("direct_negotiation_failed");
  }
}
/**
 * The initiator decided before negotiating that no direct path can exist right now (the phone has
 * no network, or is on cellular with neither STUN nor a VPN, so not even a candidate could pair).
 * Not a failure: nothing was offered, nothing is retired, and no fallback warning is shown.
 */
export class DirectSkipped extends LinkError {
  constructor() {
    super("direct_skipped");
  }
}

/** Only fixed categories leave this function; never return a candidate or a parsed address. */
export function rtcCandidateType(candidate: string): keyof z.infer<typeof counts> {
  const fields = candidate.trim().split(/\s+/);
  if (fields[6] !== "typ") return "unknown";
  const type = fields[7];
  if (type === "host") return /\.local\.?$/i.test(fields[4] ?? "") ? "mdns" : "host";
  return type === "srflx" || type === "prflx" || type === "relay" ? type : "unknown";
}

export function directDiagnostics(sink?: DirectDiagnosticSink) {
  const empty = () => ({ host: 0, mdns: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 });
  const local = empty(),
    remote = empty();
  const seen = { local: new Set<string>(), remote: new Set<string>() };
  let iceFailed = false,
    channelFailed = false,
    // ICE started checking pairs but never got one through (seen with a VPN TUN on either side).
    iceStuck = false;
  let states = 0;
  const emit = (event: DirectDiagnostic) => {
    emitDirectDiagnostic(sink, event);
  };
  const snapshot = () => emit({ event: "candidates", local: { ...local }, remote: { ...remote } });
  const candidate = (direction: "local" | "remote", value: string) => {
    if (value.length > 16 * 1024 || seen[direction].size >= 256) return;
    // Dedup SDP/trickle observations without retaining interface addresses in diagnostics.
    const fingerprint = base64url(sha256(utf8(value)));
    if (seen[direction].has(fingerprint)) return;
    seen[direction].add(fingerprint);
    const selected = direction === "local" ? local : remote;
    selected[rtcCandidateType(value)]++;
  };
  return {
    candidate,
    wireCandidate(direction: "local" | "remote", value: string) {
      if (!value || value.length > 16 * 1024) return;
      try {
        const parsed = z
          .object({ candidate: z.string().max(16 * 1024) })
          .safeParse(JSON.parse(value));
        if (parsed.success) candidate(direction, parsed.data.candidate);
      } catch {
        /* The adapter owns wire validation; diagnostics never change negotiation. */
      }
    },
    sdp(direction: "local" | "remote", value: string) {
      for (const line of value.split(/\r?\n/))
        if (line.startsWith("a=candidate:")) candidate(direction, line.slice(2));
    },
    state(event: RtcState) {
      if ((event.event === "ice" || event.event === "connection") && event.state === "failed")
        iceFailed = true;
      if (event.event === "ice" && event.state === "checking") iceStuck = true;
      if (event.event === "ice" && (event.state === "connected" || event.state === "completed"))
        iceStuck = false;
      if (event.event === "channel" && (event.state === "error" || event.state === "closed"))
        channelFailed = true;
      // A flapping native implementation must not turn local diagnostics into an unbounded log.
      if (states++ >= 64) return;
      emit(event);
      if (event.event === "gathering" && event.state === "complete") snapshot();
    },
    reason(timeout: boolean, stage: z.infer<typeof DirectStageSchema>): DirectFailure {
      if (stage === "setup") return "rtc_unavailable";
      const mdnsOnly = (value: typeof local) =>
        value.mdns > 0 && value.host === 0 && value.srflx === 0 && value.prflx === 0;
      if (mdnsOnly(local) || mdnsOnly(remote)) return "local_mdns_only";
      if (timeout && stage === "channel" && (!seen.local.size || !seen.remote.size))
        return "no_candidates";
      if (timeout && (stage === "channel" || stage === "ready")) return "ice_timeout";
      if (iceFailed) return "ice_failed";
      if (channelFailed) return "channel_failed";
      // A platform channel deadline (the phone waits 20 s) can end an attempt still checking pairs
      // before the shared timeout: that is connectivity, not signaling (owner's phone, 2026-11-11).
      if (iceStuck) return "ice_timeout";
      return timeout ? "negotiation_timeout" : "signaling_failed";
    },
    failure(stage: z.infer<typeof DirectStageSchema>, reason: DirectFailure) {
      snapshot();
      emit({ event: "failure", stage, reason });
    },
    finish() {
      snapshot();
      seen.local.clear();
      seen.remote.clear();
    },
  };
}
