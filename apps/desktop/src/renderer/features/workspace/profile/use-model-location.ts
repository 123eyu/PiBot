import type { Provider } from "@pibot/protocol";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";

export function isLoopbackModelUrl(value: string) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  return ["localhost", "[::1]"].includes(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function useModelLocation(providerId: string | null | undefined, providers: Provider[]) {
  const { peer } = useRpc();
  const provider = providers.find((provider) => provider.id === providerId);
  const version = useRef(0);
  const [revision, setRevision] = useState(0);
  const [endpoint, setEndpoint] = useState<{
    peer: typeof peer;
    id: string;
    providers: Provider[];
    revision: number;
    local: boolean;
  }>();
  useRpcEvent("providers.changed", () => {
    // Invalidate before a catalog refresh, including when that refresh fails.
    version.current++;
    setEndpoint(undefined);
    setRevision(version.current);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A refreshed catalog may contain an edited custom endpoint under the same id.
  useEffect(() => {
    let active = true;
    const requestedVersion = version.current;
    setEndpoint(undefined);
    if (!peer || !providerId || provider?.auth !== "custom") return;
    void peer
      .call("customProviders.get", { providerId })
      .then((info) => {
        if (active && version.current === requestedVersion && info?.id === providerId)
          setEndpoint({
            peer,
            id: providerId,
            providers,
            revision: requestedVersion,
            local: isLoopbackModelUrl(info.baseUrl),
          });
      })
      .catch(() => {
        // Unknown endpoints remain cloud/unknown; never promise that remote custom APIs are local.
        if (active && version.current === requestedVersion) setEndpoint(undefined);
      });
    return () => {
      active = false;
    };
  }, [peer, providerId, provider?.auth, providers, revision]);
  const confirmed =
    endpoint?.peer === peer &&
    endpoint?.id === providerId &&
    endpoint?.providers === providers &&
    endpoint?.revision === version.current;
  return {
    name: provider?.name ?? providerId ?? "",
    local:
      !peer || !provider
        ? null
        : provider.auth !== "custom"
          ? false
          : confirmed
            ? (endpoint?.local ?? null)
            : null,
  };
}
