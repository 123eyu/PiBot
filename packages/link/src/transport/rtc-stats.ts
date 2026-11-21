import { z } from "zod";
import { isLanAddress } from "./lan.ts";

/**
 * What a direct path runs on, from the platform's `getStats()`: numbers, an opaque pair id and the
 * pair kind only, never addresses or ports. Both RTC adapters (desktop renderer, phone) share it,
 * so both logs and both device cards classify a pair the same way.
 */
export const PathStatsSchema = z.strictObject({
  kind: z.enum(["lan", "punched", "relay", "unknown"]),
  /** The stats id of the selected candidate pair: only ever compared, never logged. */
  pair: z.string().min(1).max(128).optional(),
  /** ICE round trip on the selected pair (STUN consent checks), ms. */
  rttMs: z.number().int().min(0).max(600_000).optional(),
  /** Candidate pairs that succeeded / are still being checked. */
  pairs: z.number().int().min(0).max(1024),
  checking: z.number().int().min(0).max(1024),
});
export type PathStats = z.infer<typeof PathStatsSchema>;

interface StatsReport {
  forEach(fn: (value: Record<string, unknown>) => void): void;
  get(id: string): unknown;
}

export function rtcPathStats(stats: StatsReport): PathStats {
  let selectedId: string | undefined;
  let nominated: Record<string, unknown> | undefined;
  let pairs = 0;
  let checking = 0;
  stats.forEach((value) => {
    // The transport names the pair it sends on; "nominated" lags behind it on the controlled
    // side and right after the channel opened (phone log 2026-11-15: kind alternated with unknown).
    if (value.type === "transport" && typeof value.selectedCandidatePairId === "string")
      selectedId = value.selectedCandidatePairId;
    if (value.type !== "candidate-pair") return;
    if (value.state === "succeeded") {
      pairs++;
      if (value.nominated === true || value.selected === true) nominated = value;
    } else if (value.state === "in-progress" || value.state === "waiting") checking++;
  });
  const fromTransport = selectedId
    ? (stats.get(selectedId) as Record<string, unknown> | undefined)
    : undefined;
  const pair = fromTransport ?? nominated;
  const counts = { pairs: Math.min(pairs, 1024), checking: Math.min(checking, 1024) };
  if (!pair) return { kind: "unknown", ...counts };
  const id = typeof pair.id === "string" && pair.id.length <= 128 ? pair.id : undefined;
  const rtt =
    typeof pair.currentRoundTripTime === "number" && Number.isFinite(pair.currentRoundTripTime)
      ? Math.min(600_000, Math.max(0, Math.round(pair.currentRoundTripTime * 1000)))
      : undefined;
  const base = { ...(id ? { pair: id } : {}), ...(rtt !== undefined ? { rttMs: rtt } : {}) };
  const local = stats.get(pair.localCandidateId as string) as Record<string, unknown> | undefined;
  const remote = stats.get(pair.remoteCandidateId as string) as Record<string, unknown> | undefined;
  if (!local || !remote) return { kind: "unknown", ...base, ...counts };
  if (local.candidateType === "relay" || remote.candidateType === "relay")
    return { kind: "relay", ...base, ...counts };
  if (local.candidateType === "host" && remote.candidateType === "host")
    return { kind: "lan", ...base, ...counts };
  // On one Wi-Fi the first check often arrives before the trickled host candidate, so the pair
  // is peer-reflexive although both ends use their private addresses (v0.0.2 phone test: every
  // same-network attempt was dropped as "not LAN"). Private on both ends is the LAN.
  const address = (candidate: Record<string, unknown>) =>
    String(candidate.address ?? candidate.ip ?? "");
  if (isLanAddress(address(local)) && isLanAddress(address(remote)))
    return { kind: "lan", ...base, ...counts };
  return { kind: "punched", ...base, ...counts };
}
