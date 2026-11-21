import { z } from "zod";

const CandidateSchema = z.strictObject({
  candidate: z
    .string()
    .min(1)
    .max(16 * 1024),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
function allowedCandidate(value: string, allowStun: boolean) {
  if (/[\r\n\0]/.test(value)) return false;
  const fields = value.trim().split(/\s+/);
  // The type has a fixed position; matching an extension could misclassify a relay candidate.
  return (
    fields[6] === "typ" &&
    (fields[7] === "host" || (allowStun && (fields[7] === "srflx" || fields[7] === "prflx")))
  );
}

/** Both SDP and trickled candidates obey the local setting; peers cannot enable STUN or TURN. */
export function parseRtcCandidate(value: string, allowStun: boolean) {
  if (value === "") return undefined;
  if (value.length > 16 * 1024) throw new Error("invalid_rtc_candidate");
  const parsed = CandidateSchema.parse(JSON.parse(value));
  if (!allowedCandidate(parsed.candidate, allowStun)) throw new Error("invalid_rtc_candidate");
  return parsed;
}

export function dataOnlyRtcSdp(sdp: string, allowStun: boolean) {
  if (!sdp || sdp.length > 128 * 1024) throw new Error("invalid_rtc_sdp");
  const lines = sdp.split(/\r?\n/);
  const media = lines.filter((line) => line.startsWith("m="));
  if (
    media.length !== 1 ||
    !media[0]?.startsWith("m=application ") ||
    lines.some((line) => line.startsWith("a=candidate:") && !allowedCandidate(line, allowStun))
  )
    throw new Error("invalid_rtc_sdp");
  return sdp;
}

/**
 * ICE `disconnected` is transient: consent checks missed for a few seconds on a lossy uplink and
 * usually recover. Closing on it dropped healthy direct paths every few minutes (owner's phone,
 * 2026-11-11), so only `failed`/`closed` end a path at once; `disconnected` gets this long.
 */
export const ICE_DISCONNECTED_GRACE_MS = 8000;
export function iceVerdict(ice: string, connection: string): "ok" | "wait" | "close" {
  if (["failed", "closed"].includes(ice) || ["failed", "closed"].includes(connection))
    return "close";
  if (ice === "disconnected" || connection === "disconnected") return "wait";
  return "ok";
}
