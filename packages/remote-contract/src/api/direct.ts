import { z } from "zod";

export const DEFAULT_STUN_URL = "stun:stun.cloudflare.com:3478";

/** One UDP STUN authority; credentials, TURN, paths and query options have no authority here. */
export const StunUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    const match = /^stun:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
    if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return false;
    const host = match[1] as string;
    if (
      !host.startsWith("[") &&
      !host
        .split(".")
        .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
    )
      return false;
    try {
      return !!new URL(`http://${host}`).hostname;
    } catch {
      return false;
    }
  }, "Invalid STUN address");

export const RemoteDirectSchema = z.strictObject({
  mode: z.enum(["lan", "stun"]),
  stunUrl: StunUrlSchema,
});
// Maintainers 2026-11-15: direct first on every network, so hole punching is on by default;
// the phone-link disclosure accepted before pairing names the STUN request. Stored settings keep
// their value, so existing installs are unchanged.
export const defaultRemoteDirect = () => ({ mode: "stun" as const, stunUrl: DEFAULT_STUN_URL });
export type RemoteDirect = z.infer<typeof RemoteDirectSchema>;
// Keep the wire projection independent of the link implementation (contract is a leaf package).
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

/** Configuration inventory for the privacy ledger; never evidence of an actual network request. */
export function remoteStunConnection(settings: { enabled: boolean; direct: RemoteDirect }) {
  return {
    kind: "stun" as const,
    address: settings.direct.stunUrl,
    enabled: settings.enabled && settings.direct.mode === "stun",
    dataCategory: "public_ip" as const,
    forwardsData: false as const,
  };
}
