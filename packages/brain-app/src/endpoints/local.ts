import type { CapabilityContext } from "@pibot/brain/kit";
import type { EndpointCapabilityDefinition } from "@pibot/protocol-base";
import type { EndpointCapabilityRegistry } from "./registry.ts";
export function registerLocal(
  registry: EndpointCapabilityRegistry,
  ctx: CapabilityContext,
  catalog: readonly EndpointCapabilityDefinition[],
) {
  const host = ctx.host;
  const supported = new Map([
    ["desktop.computer", !!host.computer],
    ["desktop.browser", !!host.browser],
    ["desktop.office-render", !!host.office],
  ]);
  registry.receive(
    "local",
    {
      endpointKind: "desktop",
      platform: ctx.local.deps.platform,
      appVersion: "legacy",
      capabilities: catalog
        .filter((d) => d.kind === "desktop")
        .map((d) => ({
          id: d.id,
          version: d.version,
          availability: supported.get(d.id) ? "available" : "unsupported",
        })),
    },
    supported,
  );
}
