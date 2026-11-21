import type { Peer } from "@pibot/renderer-kit";
import { useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { useCallback, useEffect } from "react";
import { useConnectorRead } from "../shell/remote.ts";
import { ConnectorFeedback } from "./ConnectorFeedback.tsx";
import styles from "./connectors.module.css";

/** Where this connection's data goes, by destination and category; never content. */
export function ConnectorDataDestinations({ id, snapshot }: { id: string; snapshot: number }) {
  const { t, language } = useSettings();
  const load = useCallback(
    (peer: Peer, signal: AbortSignal) =>
      peer.call("connectors.dataDestinations", { id }, { signal }),
    [id],
  );
  const read = useConnectorRead(load);
  const refresh = read.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A connector change (mode, tools, reconnect) retires the projection.
  useEffect(() => refresh(), [snapshot, refresh]);
  useRpcEvent("chat.done", refresh);
  useRpcEvent("drafts.changed", refresh);
  const separator = language === "zh" ? "、" : ", ";
  return (
    <section className={styles.stack}>
      <h3>{t("connectors.destinations")}</h3>
      <p className={styles.note}>{t("connectors.destinationsNote")}</p>
      <ConnectorFeedback loading={read.loading} error={read.error} retry={refresh} />
      {read.value?.items.map((item) => (
        <div
          className={styles.row}
          key={item.destination.kind === "domain" ? item.destination.domain : "this_computer"}
        >
          <strong className={item.destination.kind === "domain" ? styles.mono : undefined}>
            {item.destination.kind === "domain"
              ? item.destination.domain
              : t("connectors.destination.this_computer")}
          </strong>
          <span className={styles.grow}>
            {item.categories
              .map((category) => t(`connectors.dataCategory.${category}`))
              .join(separator)}
          </span>
          <span className={styles.note}>
            {item.lastAt
              ? t("connectors.lastUsed", { time: new Date(item.lastAt).toLocaleString() })
              : t("connectors.neverUsed")}
          </span>
        </div>
      ))}
      {read.value && !read.value.items.length && (
        <p className={styles.note}>{t("connectors.noDestinations")}</p>
      )}
    </section>
  );
}
