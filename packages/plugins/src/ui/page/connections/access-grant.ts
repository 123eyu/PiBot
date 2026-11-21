import type { Connector, ConnectorAccess, PluginSummary } from "@pibot/plugins-contract/full";
import type { Peer } from "@pibot/renderer-kit";

export type AccessTarget = { kind: "bot" | "group"; id: string };

const everyone = (access: ConnectorAccess) => access.mode === "all" || access.mode === "ask_first";

/** "Everyone" means every Bot; a group still has to be named, so it is off until chosen. */
export function accessIsOn(access: ConnectorAccess, { kind, id }: AccessTarget) {
  return kind === "bot"
    ? everyone(access) || access.bots.includes(id)
    : !everyone(access) && access.groups.includes(id);
}

/**
 * Who-can-use with `target` flipped. Leaving "everyone" lists every live Bot explicitly, so taking
 * one away (or adding a group) keeps all the others. Shared by knowledge sources, whose
 * stored targets use the same all/some meaning.
 */
export function flipAccess(
  access: ConnectorAccess,
  botIds: readonly string[],
  target: AccessTarget,
): ConnectorAccess {
  const current = everyone(access)
    ? { bots: [...botIds], groups: [] as string[] }
    : { bots: [...access.bots], groups: [...access.groups] };
  const list = target.kind === "bot" ? current.bots : current.groups;
  const next = list.includes(target.id)
    ? list.filter((item) => item !== target.id)
    : [...list, target.id];
  return {
    mode: "selected",
    bots: target.kind === "bot" ? next : current.bots,
    groups: target.kind === "group" ? next : current.groups,
  };
}

function toggledAccess(summary: PluginSummary, botIds: readonly string[], target: AccessTarget) {
  const access = summary.access;
  const wide = everyone(access);
  const list = target.kind === "bot" ? access.bots : access.groups;
  // A brought-over connection arrives switched off and given to nobody; the first person given
  // it switches it on. A connection someone switched off themselves stays off.
  const firstGrant =
    !!summary.originTool &&
    !list.includes(target.id) &&
    !wide &&
    !access.bots.length &&
    !access.groups.length;
  return { access: flipAccess(access, botIds, target), firstGrant };
}

/**
 * Flips one Bot / group in a connection's who-can-use (`connectors.update` with the first
 * connector's revision, which owns the shared access row) and, on a first grant, starts the
 * plugin's switched-off connectors, reporting each start as soon as it is accepted.
 */
export async function toggleConnectionAccess(
  peer: Peer,
  signal: AbortSignal,
  input: {
    summary: PluginSummary;
    connectors: readonly Connector[];
    botIds: readonly string[];
    target: AccessTarget;
    started?(operationId: string, installationId: string, connectorId: string): void;
  },
) {
  const first = input.connectors[0];
  if (!first) return;
  const { access, firstGrant } = toggledAccess(input.summary, input.botIds, input.target);
  const saved = await peer.call(
    "connectors.update",
    { id: first.id, expectedRevision: first.revision, access },
    { signal },
  );
  if (!firstGrant) return;
  for (const connector of input.connectors)
    if (!connector.enabled && connector.status === "disabled") {
      // The shared access row bumps every connector of the plugin by one revision.
      const revision = connector.id === saved.id ? saved.revision : connector.revision + 1;
      const result = await peer.call(
        "connectors.setEnabled",
        { id: connector.id, expectedRevision: revision, enabled: true },
        { signal },
      );
      input.started?.(result.operationId, connector.pluginInstallationId, connector.id);
    }
}
