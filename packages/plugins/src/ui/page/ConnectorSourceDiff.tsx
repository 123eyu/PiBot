import type { ConnectorSourceDetails } from "@pibot/plugins-contract/full";
import { useT } from "@pibot/renderer-kit";
import styles from "./connectors.module.css";

export function ConnectorSourceDiff({ details }: { details: ConnectorSourceDetails }) {
  const t = useT();
  const pair = (label: string, before: string[], after: string[]) => (
    <details>
      <summary>{label}</summary>
      <p className={styles.note}>{t("connectors.sourceDetails.before")}</p>
      <pre className={styles.stderrTail}>{before.join("\n") || "—"}</pre>
      <p className={styles.note}>{t("connectors.sourceDetails.after")}</p>
      <pre className={styles.stderrTail}>{after.join("\n") || "—"}</pre>
    </details>
  );
  return (
    <div className={styles.stack}>
      {details.servers.map((server) => (
        <section key={server.id} className={styles.stack}>
          <strong>{server.id}</strong>
          {server.command &&
            pair(
              t("connectors.sourceDetails.command"),
              [server.command.before],
              [server.command.after],
            )}
          {server.arguments &&
            pair(
              t("connectors.sourceDetails.arguments"),
              server.arguments.before,
              server.arguments.after,
            )}
          {(server.envNames.added.length > 0 || server.envNames.removed.length > 0) && (
            <div>
              <p>{t("connectors.sourceDetails.envNames")}</p>
              <p>
                {t("connectors.sourceDetails.added")}: {server.envNames.added.join(", ") || "—"}
              </p>
              <p>
                {t("connectors.sourceDetails.removed")}: {server.envNames.removed.join(", ") || "—"}
              </p>
            </div>
          )}
          {JSON.stringify(server.websites.before) !== JSON.stringify(server.websites.after) &&
            pair(
              t("connectors.sourceDetails.websites"),
              server.websites.before,
              server.websites.after,
            )}
        </section>
      ))}
      {details.files && (
        <section>
          <strong>{t("connectors.sourceDetails.files")}</strong>
          <p>{t("connectors.sourceDetails.added")}</p>
          <pre className={styles.stderrTail}>{details.files.added.join("\n") || "—"}</pre>
          <p>{t("connectors.sourceDetails.removed")}</p>
          <pre className={styles.stderrTail}>{details.files.removed.join("\n") || "—"}</pre>
          {details.files.truncated && (
            <p className={styles.note}>{t("connectors.sourceDetails.truncated")}</p>
          )}
        </section>
      )}
    </div>
  );
}
