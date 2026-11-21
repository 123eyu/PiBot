import { isLanAddress } from "@pibot/link/lan";
import { getIpAddressAsync, getNetworkStateAsync, NetworkStateType } from "expo-network";

/**
 * A VPN on the phone is evidence for a failed LAN direct path (a TUN captures LAN UDP). Expo
 * reports only the default network and may say UNKNOWN or WIFI under a TUN VPN, so Android also
 * asks the local module about every network. Absence of evidence is never a positive diagnosis.
 */
async function vpnActive() {
  const state = await getNetworkStateAsync().catch(() => undefined);
  if (state?.type === NetworkStateType.VPN) return true;
  try {
    // Loaded on demand: Node probes run this transport without the native module.
    const { pibotAndroid } = await import("../../modules/pibot-android/index.ts");
    return (await pibotAndroid?.vpnActive()) ?? false;
  } catch {
    return false; // iOS, an older build without the function, or no native runtime.
  }
}
export async function mobileNetworkHint(signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await Promise.race([
      vpnActive().then((vpn) => (vpn ? ("peer_vpn_active" as const) : undefined)),
      new Promise<undefined>((resolve) => {
        abort = () => resolve(undefined);
        timer = setTimeout(abort, 1000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** Home networks are /24 almost always; the larger private ranges are compared by /16. */
function sameSubnet(a: string, b: string) {
  const width = a.startsWith("192.168.") ? 3 : 2;
  return a.split(".").slice(0, width).join(".") === b.split(".").slice(0, width).join(".");
}
function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
/**
 * Where the phone is relative to the computer's LAN. `lan`: Wi-Fi / Ethernet on a subnet of one of
 * the computer's LAN addresses (or none advertised); `other_subnet`: Wi-Fi elsewhere; `unknown`: a
 * VPN or an unusual network type hides what is underneath (under a TUN VPN Expo says WIFI but
 * returns the tunnel's address, v0.0.2 round 3: FlClash 172.19.0.1 next to a 192.168.31.x Mac).
 */
export type PhoneNetworkKind = "none" | "cellular" | "other_subnet" | "lan" | "unknown";
export interface PhoneNetwork {
  kind: PhoneNetworkKind;
  vpn: boolean;
}
async function networkFacts(lanHints: readonly string[]): Promise<PhoneNetwork | undefined> {
  const state = await getNetworkStateAsync().catch(() => undefined);
  if (!state) return undefined;
  if (state.isConnected === false || state.type === NetworkStateType.NONE)
    return { kind: "none", vpn: false };
  const vpn = await vpnActive();
  if (state.type === NetworkStateType.CELLULAR) return { kind: "cellular", vpn };
  if (vpn || (state.type !== NetworkStateType.WIFI && state.type !== NetworkStateType.ETHERNET))
    return { kind: "unknown", vpn };
  const ip = await getIpAddressAsync().catch(() => "");
  if (!isLanAddress(ip)) return { kind: "unknown", vpn };
  const hosts = lanHints.map(hostOf).filter(isLanAddress);
  return {
    kind: hosts.length && !hosts.some((host) => sameSubnet(host, ip)) ? "other_subnet" : "lan",
    vpn,
  };
}
/**
 * What the phone's network says about the direct options (maintainers 2026-11-15: direct first in every
 * situation; on the same LAN directly, off it or behind a VPN / proxy through the internet). Only
 * "no network" rules every direct attempt out; the rest decides which kinds are worth a try.
 * Undefined when the platform did not answer within a second: then everything is tried.
 */
export async function phoneNetwork(lanHints: readonly string[], signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await Promise.race([
      networkFacts(lanHints),
      new Promise<undefined>((resolve) => {
        abort = () => resolve(undefined);
        timer = setTimeout(abort, 1000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
