import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { RelayUrlSchema, type RemoteSettings } from "@pibot/remote-contract";
import type { RemoteResources } from "../runtime/context.ts";
import type { RemoteOptions } from "../runtime/service.ts";
export function validateSettingsChange(
  r: RemoteResources,
  options: RemoteOptions,
  expectedVersion: number,
  patch: Partial<Omit<RemoteSettings, "version">>,
  disclosureAccepted?: boolean,
) {
  const old = r.settings.get();
  if (old.version !== expectedVersion)
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_settings_stale");
  const next = { ...old, ...patch };
  const relayChanged = old.relay !== next.relay || old.relayUrl !== next.relayUrl;
  if (
    next.direct.mode === "stun" &&
    (old.direct.mode !== "stun" || old.direct.stunUrl !== next.direct.stunUrl) &&
    !disclosureAccepted
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_stun_disclosure_required");
  // Pending revocations still need the old relay address. Never silently strand those credentials.
  if (relayChanged && r.devices.hasRooms())
    throw new RpcError(RpcErrorCodes.invalidParams, "remote_relay_has_devices");
  if (next.enabled) {
    if ((!old.enabled || relayChanged) && !disclosureAccepted)
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_disclosure_required");
    if (!options.link || !options.kernel)
      throw new RpcError(RpcErrorCodes.unsupported, "remote_link_unavailable");
    const relay = next.relay === "custom" ? next.relayUrl : options.link.officialRelayUrl;
    if (!RelayUrlSchema.safeParse(relay).success)
      throw new RpcError(RpcErrorCodes.unsupported, "remote_relay_unavailable");
    // Keep-awake is optional on headless/Linux hosts. Do not reject unrelated remote
    // settings when the requested power hint cannot be applied.
  }
  return next;
}
