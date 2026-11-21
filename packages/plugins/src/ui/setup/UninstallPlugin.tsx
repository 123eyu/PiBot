import type { BuiltinApp, PluginInstallation } from "@pibot/plugins-contract/full";
import { type Peer, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useRef } from "react";
import {
  ConnectorFeedback,
  ConnectorPagination,
  OperationStatus,
} from "../page/ConnectorFeedback.tsx";
import { ConnectorPanel } from "../page/ConnectorPanel.tsx";
import styles from "../page/connectors.module.css";
import { connectorName, uninstallPresentation } from "../page/presentation.ts";
import type { useConnectorOperations } from "../shell/operations.ts";
import { useConnectorAction, useConnectorPage } from "../shell/remote.ts";

export function UninstallPlugin({
  installation,
  name,
  skillCount,
  apps,
  snapshot,
  operations,
  changed,
  done,
  close,
}: {
  installation: PluginInstallation;
  name?: string;
  skillCount?: number;
  apps: BuiltinApp[];
  snapshot: number;
  operations: ReturnType<typeof useConnectorOperations>;
  changed(): void;
  done(): void;
  close(): void;
}) {
  const { t, language } = useSettings();
  const load = useCallback(
    (peer: Peer, signal: AbortSignal, cursor?: string) =>
      peer.call(
        "connectors.list",
        { cursor, limit: 50, installationId: installation.id },
        { signal },
      ),
    [installation.id],
  );
  const connections = useConnectorPage(load, snapshot);
  const action = useConnectorAction(changed);
  const { latest, pending, removed, recoverable, retryableCleanup, status } = uninstallPresentation(
    installation,
    operations.rows,
    connections.value?.items,
  );
  // `done` is a fresh closure each parent render and `removed` stays true until unmount; without
  // the guard the parent would refresh and announce the same removal repeatedly.
  const finished = useRef(false);
  useEffect(() => {
    if (!removed || finished.current) return;
    finished.current = true;
    done();
  }, [removed, done]);
  return (
    <ConnectorPanel title={t("connectors.uninstall")} close={close} busy={action.busy}>
      <p>
        {name ?? t("connectors.pluginFallback")} · {installation.version}
      </p>
      <p>{t("connectors.uninstallConfirm", { name: name ?? t("connectors.pluginFallback") })}</p>
      <p className={styles.note}>{t("connectors.uninstallConnections")}</p>
      {!!skillCount && <p className={styles.note}>{t("connectors.uninstallSkillsKept")}</p>}
      {connections.value?.items
        .filter((connector) => connector.pluginInstallationId === installation.id)
        .map((connector) => (
          <div className={styles.card} key={connector.id}>
            <strong>{connectorName(connector, apps, language)}</strong>
            <span>{t(`connectors.status.${connector.status}`)}</span>
          </div>
        ))}
      <ConnectorFeedback
        loading={connections.loading}
        error={connections.error}
        retry={connections.refresh}
      />
      <ConnectorPagination
        previous={connections.previous}
        next={connections.next}
        disabled={connections.loading || action.busy}
      />
      {/* The page announces 已移除 once the panel closes; a generic 操作成功 here would be a second verdict. */}
      {!removed && <OperationStatus row={latest} check={operations.check} />}
      {status && status !== "connectors.removed" && (
        <p role="status" className={recoverable ? styles.error : styles.note}>
          {t(status)}
        </p>
      )}
      {!removed && (
        // The panel itself is the confirmation (opened from 删除), so one click removes; a second
        // confirm step made removal take three clicks (second-Mac test).
        <div className={styles.row}>
          <Button variant="secondary" disabled={action.busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            className={styles.dangerButton}
            disabled={
              action.disabled ||
              pending ||
              connections.loading ||
              !!connections.error ||
              !connections.value ||
              !!connections.next
            }
            loading={action.busy}
            onClick={() =>
              void action
                .run((peer, signal) =>
                  peer.call(
                    "plugins.uninstall",
                    { installationId: installation.id, expectedRevision: installation.revision },
                    { signal },
                  ),
                )
                .then((result) => {
                  if (result) operations.track(result.operationId, installation.id, null);
                })
            }
          >
            {t(
              retryableCleanup
                ? "connectors.cleanupRetry"
                : recoverable
                  ? "connectors.uninstallRetry"
                  : "connectors.uninstall",
            )}
          </Button>
        </div>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </ConnectorPanel>
  );
}
