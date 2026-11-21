import type { MethodParams, MethodResults } from "@pibot/protocol";
import type { RemoteService } from "../runtime/service.ts";

/** A runner can drop between the device list and this read; the page must still render. */
function runnerPlatform(service: RemoteService, target: string) {
  try {
    return service.r.ctx.local.executionTargets.require(target).platform;
  } catch {
    return undefined;
  }
}
/** Phone display projection: no pairing credentials, revocation controls or private metadata. */
export function endpointDevices(
  service: RemoteService,
  { after, limit = 10 }: MethodParams["devices.endpoints"],
): MethodResults["devices.endpoints"] {
  const first = after === undefined;
  const page = service.list({
    after: after === "local" ? undefined : after,
    limit: first ? Math.max(1, limit - 1) : limit,
  });
  const items: MethodResults["devices.endpoints"]["items"] = page.items
    .filter((d) => !d.revokedAt)
    .map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      target: d.target,
      platform:
        (d.online && d.target && runnerPlatform(service, d.target)) || d.phoneData?.platform,
      online: d.online,
      path: d.online ? (d.runnerConnection?.path ?? d.path) : undefined,
    }));
  // The local endpoint stays visible even without registered capabilities. Its cursor has its
  // own namespace; device IDs are UUIDs, so it cannot collide with an actual paired device.
  if (first)
    items.unshift({
      id: "local",
      name: "This computer / 这台电脑",
      kind: "desktop",
      platform: service.r.ctx.local.deps.platform,
      online: true,
    });
  const visible = items.slice(0, limit);
  return {
    items: visible,
    nextAfter: items.length > limit ? (visible.at(-1)?.id ?? null) : page.nextAfter,
  };
}
