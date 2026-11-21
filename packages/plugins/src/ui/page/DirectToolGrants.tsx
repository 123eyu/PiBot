import type { Peer } from "@pibot/renderer-kit";
import { useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback } from "react";
import { useConnectorAction, useConnectorPage } from "../shell/remote.ts";
import { ConnectorFeedback, ConnectorPagination } from "./ConnectorFeedback.tsx";
import styles from "./connectors.module.css";

export function DirectToolGrants({ id }: { id: string }) {
  const t = useT();
  const load = useCallback(
    async (peer: Peer, signal: AbortSignal, cursor?: string) => {
      const items = await peer.call(
        "grants.list",
        { connectorId: id, before: cursor, limit: 20 },
        { signal },
      );
      const rows = await Promise.all(
        items.map(async (grant) => {
          try {
            const target = grant.groupId
              ? await peer.call("groups.get", { groupId: grant.groupId }, { signal })
              : (await peer.call("bots.profile", { botId: grant.botId }, { signal })).bot;
            return { grant, name: target.name };
          } catch {
            signal.throwIfAborted();
            // Target metadata is optional; its failure must never hide the revoke action.
            return { grant, name: undefined };
          }
        }),
      );
      return { items: rows, nextCursor: items.length === 20 ? (items.at(-1)?.id ?? null) : null };
    },
    [id],
  );
  const page = useConnectorPage(load, 0);
  const action = useConnectorAction(page.refresh);
  useRpcEvent("permissions.changed", page.refresh);
  useRpcEvent("approval.resolved", page.refresh);
  return (
    <section className={styles.stack}>
      <h3>{t("connectors.directGrants")}</h3>
      <ConnectorFeedback loading={page.loading} error={page.error} retry={page.refresh} />
      {page.value?.items.map(({ grant, name }) => (
        <div className={styles.row} key={grant.id}>
          <span>
            {grant.scope.kind === "connector_tool" ? grant.scope.tool : ""} ·{" "}
            {name ?? t(grant.groupId ? "connectors.unavailableGroup" : "connectors.unavailableBot")}{" "}
            · {new Date(grant.createdAt).toLocaleString()}
          </span>
          <Button
            variant="ghost"
            disabled={action.disabled}
            onClick={() =>
              void action.run((peer, signal) =>
                peer.call("grants.revoke", { id: grant.id }, { signal }),
              )
            }
          >
            {t("connectors.revokeDirect")}
          </Button>
        </div>
      ))}
      {page.value && !page.value.items.length && (
        <p className={styles.note}>{t("connectors.noDirectGrants")}</p>
      )}
      <ConnectorFeedback loading={false} error={action.error} retry={page.refresh} />
      <ConnectorPagination previous={page.previous} next={page.next} disabled={page.loading} />
    </section>
  );
}
