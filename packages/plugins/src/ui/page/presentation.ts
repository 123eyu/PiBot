import type { BuiltinApp, Connector, PluginInstallation } from "@pibot/plugins-contract/full";
import { type OperationRow, operationPending } from "../shell/operations.ts";

/** Only the service's trusted app ID selects a catalog translation. Custom names remain intact. */
export function connectorName(
  connector: Connector,
  apps: readonly BuiltinApp[],
  language: "zh" | "en",
) {
  return apps.find((app) => app.id === connector.appId)?.name[language] ?? connector.name;
}

export function visibleInstallations(
  installations: readonly PluginInstallation[],
  connections: readonly Connector[],
) {
  const represented = new Set(connections.map((connector) => connector.pluginInstallationId));
  // Keep orphaned and paginated-away installations reachable, including failed removals.
  return installations.filter(
    (installation) =>
      installation.status !== "removed" &&
      (installation.sourceKind !== "builtin" || !represented.has(installation.id)),
  );
}

export function uninstallPresentation(
  installation: PluginInstallation,
  operations: readonly OperationRow[],
  connections: readonly Connector[] = [],
) {
  const rows = operations.filter((row) => row.installationId === installation.id);
  const latest = rows
    .filter(
      (row) => row.connectorId === null && (!row.operation || row.operation.kind === "uninstall"),
    )
    .reduce<OperationRow | undefined>((previous, row) => {
      const before = previous?.operation?.createdAt,
        current = row.operation?.createdAt;
      // A delayed event for an older attempt must not replace a newer uninstall outcome.
      return before && current && before > current ? previous : row;
    }, undefined);
  const retryableCleanup = latest?.operation
    ? latest.operation.failureCode === "cleanup_incomplete"
    : connections.some(
        (connector) =>
          connector.pluginInstallationId === installation.id &&
          connector.statusDetailCode === "cleanup_incomplete",
      );
  const pending = rows.some(
    (row) => operationPending(row) && !(row.id === latest?.id && retryableCleanup),
  );
  const removed = installation.status === "removed" || latest?.operation?.state === "done";
  const state = latest?.operation?.state;
  const status = removed
    ? ("connectors.removed" as const)
    : retryableCleanup
      ? ("connectors.cleanupIncomplete" as const)
      : latest?.unknown
        ? ("connectors.uninstallUnknown" as const)
        : state === "error"
          ? ("connectors.uninstallFailed" as const)
          : state === "cancelled"
            ? ("connectors.uninstallCancelled" as const)
            : latest && operationPending(latest)
              ? ("connectors.removing" as const)
              : installation.status === "removing"
                ? ("connectors.uninstallUnknown" as const)
                : undefined;
  return {
    latest,
    pending,
    removed,
    status,
    retryableCleanup,
    recoverable:
      !removed &&
      (installation.status === "removing" ||
        latest?.unknown === true ||
        state === "error" ||
        state === "cancelled"),
  };
}
