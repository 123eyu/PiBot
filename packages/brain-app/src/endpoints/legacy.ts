import type {
  CapabilityManifest,
  EndpointCapabilityDefinition,
  EndpointPresence,
} from "@pibot/protocol-base";

// Same set as remote-contract's LEGACY_PHONE_CAPABILITIES; this L4 file cannot import upward.
const LEGACY_PHONE_CAPABILITIES: ReadonlySet<string> = new Set(["phone.media", "phone.sms"]);

/** Legacy reports describe existing switches; they never override an explicit registry choice. */
export function legacyEndpoint(
  d: EndpointPresence,
  endpointCapabilityCatalog: readonly EndpointCapabilityDefinition[],
) {
  // A phone without a manifest only ever had media and SMS switches; newer phone capabilities are
  // never synthesized or seeded from them (they wait for a real manifest and start off).
  const defs = endpointCapabilityCatalog.filter(
    (c) => c.kind === d.kind && (d.kind !== "phone" || LEGACY_PHONE_CAPABILITIES.has(c.id)),
  );
  const manifest: CapabilityManifest = {
    endpointKind: d.kind,
    platform: d.phoneData?.platform ?? "linux",
    appVersion: "legacy",
    capabilities: defs.map((c) => ({
      id: c.id,
      version: c.version,
      availability:
        d.kind === "runner"
          ? c.id === "runner.exec" && d.isolation?.available === false
            ? "unsupported"
            : "available"
          : c.id === "phone.sms" && d.phoneData?.platform === "ios"
            ? "unsupported"
            : (c.id === "phone.media" ? d.phoneData?.media : d.phoneData?.smsCode)
              ? "available"
              : "local_switch_off",
    })),
  };
  // Existing preferences only seed the first row; explicit registry choices always win.
  const legacy = new Map(
    defs.map((c) => [
      c.id,
      d.kind === "runner" ||
        (c.id === "phone.media" ? !!d.phoneData?.media : !!d.phoneData?.smsCode),
    ]),
  );
  return { manifest, legacy };
}
