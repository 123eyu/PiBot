import { type ConfigPlugin, withAndroidManifest, withInfoPlist } from "expo/config-plugins";

/** Dynamic private IPv4 endpoints cannot be listed as fixed Android cleartext domains. */
export const withLanDiscovery: ConfigPlugin = (config) => {
  config = withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application?.$) throw new Error("lan_android_application_missing");
    // LAN WebSocket is only a carrier for Noise; JS refuses non-private destination addresses.
    application.$["android:usesCleartextTraffic"] = "true";
    return next;
  });
  return withInfoPlist(config, (next) => {
    const services = next.modResults.NSBonjourServices;
    next.modResults.NSBonjourServices = [
      ...new Set([...(Array.isArray(services) ? services : []), "_pibot-link._tcp"]),
    ];
    next.modResults.NSAppTransportSecurity = {
      ...(next.modResults.NSAppTransportSecurity as Record<string, unknown>),
      NSAllowsLocalNetworking: true,
    };
    return next;
  });
};
