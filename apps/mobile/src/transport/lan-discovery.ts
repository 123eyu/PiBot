import { LAN_SERVICE } from "@pibot/link/lan";
import type { LanDiscover } from "./lan-link.ts";

/** Loaded only for a saved pairing; Expo Go and Node probes never import the native module. */
export const discoverLan: LanDiscover = async (signal, resolved) => {
  const { default: Zeroconf } = await import("react-native-zeroconf");
  signal.throwIfAborted();
  const scanner = new Zeroconf();
  let closed = false;
  let drainFailed = false;
  const error = () => {
    /* Discovery is optional; relay fallback remains available. */
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", cleanup);
    for (const release of [
      () => scanner.stop(),
      () => scanner.removeDeviceListeners(),
      () => scanner.removeAllListeners(),
    ]) {
      try {
        release();
      } catch {
        drainFailed = true;
      }
    }
  };
  scanner.on("error", error);
  scanner.on("resolved", resolved);
  signal.addEventListener("abort", cleanup, { once: true });
  try {
    const access = await scanner.checkLocalNetworkAccess({ type: LAN_SERVICE, timeout: 3 });
    signal.throwIfAborted();
    if (access === "denied") throw new Error("lan_permission_denied");
    // Browse only this type; enumerating all types would require an extra iOS entitlement.
    scanner.scan({ type: LAN_SERVICE, protocol: "tcp", domain: "local.", resolveTimeout: 3 });
    return () => {
      cleanup();
      if (drainFailed) throw new Error("drain_unconfirmed");
    };
  } catch (cause) {
    cleanup();
    if (drainFailed) throw new Error("drain_unconfirmed");
    throw cause;
  }
};
