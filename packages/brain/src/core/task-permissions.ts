import type { ExecutionMode, PermissionsSettings } from "@pibot/protocol-base";

const rank = { never: 0, ask: 1, always: 2 };

export function continuedMode(frozen: ExecutionMode, live: ExecutionMode): ExecutionMode {
  return frozen === "plan" || live === "plan" ? "plan" : "execute";
}

export function intersectTaskPermissions(
  frozen: PermissionsSettings,
  current: PermissionsSettings,
): PermissionsSettings {
  const levels = { ...current.levels };
  for (const key of Object.keys(levels) as (keyof typeof levels)[])
    if (rank[frozen.levels[key]] < rank[levels[key]]) levels[key] = frozen.levels[key];
  const network = frozen.network.allowAll
    ? current.network
    : current.network.allowAll
      ? frozen.network
      : {
          allowAll: false,
          domains: frozen.network.domains.filter((domain) =>
            current.network.domains.includes(domain),
          ),
        };
  return {
    levels,
    network,
    pathEntries: (frozen.pathEntries ?? []).filter((path) => current.pathEntries?.includes(path)),
    dockerRuntime:
      frozen.dockerRuntime === current.dockerRuntime ? frozen.dockerRuntime : "disabled",
  };
}

export function taskPermissionsNarrowed(frozen: PermissionsSettings, current: PermissionsSettings) {
  const fingerprint = (value: PermissionsSettings) =>
    JSON.stringify([
      value.levels,
      value.network,
      value.pathEntries ?? [],
      value.dockerRuntime ?? "disabled",
    ]);
  return fingerprint(intersectTaskPermissions(frozen, current)) !== fingerprint(frozen);
}
