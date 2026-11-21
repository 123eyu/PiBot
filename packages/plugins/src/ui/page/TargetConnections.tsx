import {
  accessAllows,
  type ConnectionAvailability,
  type ConnectionTarget,
  type Connector,
  type ConnectorAccess,
} from "@pibot/plugins-contract/full";
import {
  type Peer,
  botPanelStyles as styles,
  useNavigation,
  useRpc,
  useRpcEvent,
  useSettings,
} from "@pibot/renderer-kit";
import { IconTile, Switch } from "@pibot/ui";
import { useCallback, useState } from "react";
import { connectorError, useConnectorPage } from "../shell/remote.ts";
import { ConnectorFeedback, ConnectorPagination } from "./ConnectorFeedback.tsx";

interface Row {
  connector: Connector;
  access: ConnectorAccess;
  availability: ConnectionAvailability;
}

/**
 * 「能用的连接」 in a Bot / group skills tab. The switch edits the connection's own
 * who-can-use (connectors.update + expectedRevision); a group tab writes the group, because a group
 * run only consults group access and a private chat only Bot access.
 */
export function TargetConnections({ target }: { target: ConnectionTarget }) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const navigation = useNavigation();
  const [snapshot, setSnapshot] = useState(0);
  const changed = useCallback(() => setSnapshot((value) => value + 1), []);
  useRpcEvent("connectors.changed", changed);
  useRpcEvent("plugins.changed", changed);
  const { kind, id } = target;
  const load = useCallback(
    async (peer: Peer, signal: AbortSignal, cursor?: string) => {
      // Rebuilt from the primitives: callers pass a fresh object every render.
      const target: ConnectionTarget = kind === "bot" ? { kind: "bot", id } : { kind: "group", id };
      const page = await peer.call("connectors.list", { cursor, limit: 20 }, { signal });
      // Status comes from the shared availability judge, so this list and the chat reason strip
      // never disagree about why a connection is unusable.
      const items = await Promise.all(
        page.items.map(async (row): Promise<Row> => {
          const [detail, availability] = await Promise.all([
            peer.call("connectors.get", { id: row.id }, { signal }),
            peer.call("connections.availability", { target, connection: row.id }, { signal }),
          ]);
          return { connector: detail.connector, access: detail.access, availability };
        }),
      );
      return { items, nextCursor: page.nextCursor };
    },
    [kind, id],
  );
  const rows = useConnectorPage(load, snapshot);
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<ReturnType<typeof connectorError>>();
  const allowed = (access: ConnectorAccess) =>
    target.kind === "bot"
      ? accessAllows(access, target.id)
      : access.mode !== "selected" || access.groups.includes(target.id);
  const toggle = async ({ connector, access }: Row, enabled: boolean) => {
    if (!peer || busy || access.mode !== "selected") return;
    const change = (ids: readonly string[]) =>
      enabled ? [...new Set([...ids, target.id])] : ids.filter((id) => id !== target.id);
    setBusy(connector.id);
    setFailure(undefined);
    try {
      await peer.call("connectors.update", {
        id: connector.id,
        expectedRevision: connector.revision,
        access: {
          mode: "selected",
          bots: target.kind === "bot" ? change(access.bots) : access.bots,
          groups: target.kind === "group" ? change(access.groups) : access.groups,
        },
      });
    } catch (error) {
      setFailure(connectorError(error));
    } finally {
      setBusy(undefined);
      // A stale revision or a failed write must show the server's current access, not the click.
      rows.refresh();
    }
  };
  const open = (row: Row, section?: "access") => {
    navigation.openPage("connectors");
    navigation.navigate({
      name: "connectors",
      // The target only travels with the access section, where details preselects it.
      connection: {
        id: row.connector.id,
        connectorId: row.connector.id,
        ...(section ? { target, section } : {}),
      },
    });
  };
  const label = t(
    target.kind === "bot" ? "connectors.target.allowBot" : "connectors.target.allowGroup",
  );
  return (
    <section className={styles.section} aria-label={t("connectors.target.title")}>
      <h2>{t("connectors.target.title")}</h2>
      {!!rows.value?.items.length && (
        <div className={styles.card}>
          {rows.value.items.map((row) => {
            const name = row.availability.name[language] || row.connector.name;
            const everyone = row.access.mode !== "selected";
            return (
              <div className={styles.cardRow} key={row.connector.id}>
                {/* Blue while usable, amber when it needs the user, grey otherwise. */}
                <IconTile
                  icon="plug"
                  tone={
                    row.availability.reason === "available"
                      ? "blue"
                      : row.availability.reason === "needs_auth" ||
                          row.availability.reason === "error"
                        ? "amber"
                        : "neutral"
                  }
                  size="lg"
                />
                <span className={styles.rowText}>
                  <button type="button" className={styles.rowButton} onClick={() => open(row)}>
                    <strong>{name}</strong>
                  </button>
                  <small>
                    {t(
                      row.availability.reason === "no_access"
                        ? target.kind === "group"
                          ? "connectors.reason.no_access_group"
                          : "connectors.reason.no_access_bot"
                        : `connectors.reason.${row.availability.reason}`,
                      { name },
                    )}
                    {everyone && ` · ${t("connectors.access.all")}`}
                  </small>
                  {everyone && (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => open(row, "access")}
                    >
                      {t("connectors.target.narrow")}
                    </button>
                  )}
                </span>
                <Switch
                  label={`${label} · ${name}`}
                  checked={allowed(row.access)}
                  // "All Bots" cannot drop one target without listing every other one; that
                  // narrowing is done in the details drawer where the full selection is visible.
                  disabled={!peer || !!busy || everyone}
                  onCheckedChange={(checked) => void toggle(row, checked)}
                />
              </div>
            );
          })}
        </div>
      )}
      {!rows.loading && !rows.error && !rows.value?.items.length && (
        <p className={styles.note}>{t("connectors.target.empty")}</p>
      )}
      <ConnectorFeedback loading={rows.loading} error={rows.error} retry={rows.refresh} />
      {failure && (
        <p role="alert" className={styles.error}>
          {t(failure)}
        </p>
      )}
      <ConnectorPagination
        previous={rows.previous}
        next={rows.next}
        disabled={rows.loading || !peer}
      />
    </section>
  );
}
