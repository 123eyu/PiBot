import type { Routine } from "@pibot/protocol";
import { RpcError } from "@pibot/protocol";

export function routineMutationVersion(before: Routine, after: Routine) {
  if (after.version === before.version) return after.version;
  const fields = ({
    enabled: _enabled,
    version: _version,
    updatedAt: _updated,
    ...rest
  }: Routine) => rest;
  // Draining can close the old appointment. Accept one version increment equivalent to that
  // closure; this compares fields, not writer provenance. Other edits retain the version fence.
  if (
    before.enabled &&
    !after.enabled &&
    after.version === before.version + 1 &&
    before.triggers.length === 1 &&
    before.triggers[0]?.config.kind === "once" &&
    before.triggers[0].state.consumedAt &&
    JSON.stringify(fields(before)) === JSON.stringify(fields(after))
  )
    return after.version;
  throw new RpcError(-32602, "Routine version changed");
}
