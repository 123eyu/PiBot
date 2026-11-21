import { useCredentialList } from "@pibot/credentials/ui";
import { useConnectorPage } from "@pibot/plugins/ui";
import {
  type Peer,
  botPanelStyles as styles,
  useNavigation,
  useRpcEvent,
  useT,
} from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useCallback } from "react";

/**
 * Assignment metadata lives beside remembered grants; values never enter this view. The Bot's
 * connections moved to its 「技能」 tab, where they can also be allowed.
 */
export function ProfileConnections({ botId }: { botId: string }) {
  const t = useT();
  const { navigate } = useNavigation();
  const loadSecrets = useCallback(
    async (peer: Peer, signal: AbortSignal, cursor?: string) => {
      const page = await peer.call("secrets.list", { cursor, limit: 50 }, { signal });
      return {
        items: page.items.filter(
          (row) => row.assignment.kind === "all" || row.assignment.bots.includes(botId),
        ),
        nextCursor: page.nextCursor ?? null,
      };
    },
    [botId],
  );
  const secrets = useConnectorPage(loadSecrets, 0);
  const accounts = useCredentialList(botId);
  useRpcEvent("secrets.changed", secrets.refresh);
  return (
    <>
      {(!!secrets.value?.items.length || secrets.error || secrets.next || secrets.previous) && (
        <section className={styles.section}>
          <h2>{t("connectors.secrets")}</h2>
          <div className={styles.card}>
            {secrets.value?.items.map((secret) => (
              <div key={secret.name} className={styles.cardRow}>
                <IconTile icon="key" tone="violet" size="lg" />
                <span className={styles.rowText}>
                  <strong>{secret.name}</strong>
                  <small>{secret.description}</small>
                </span>
              </div>
            ))}
          </div>
          <Button
            variant="pill"
            className={styles.smallPill}
            onClick={() => navigate({ name: "connectors" })}
          >
            {t("profile.manageSecrets")}
          </Button>
          {secrets.error && (
            <p role="alert" className={styles.error}>
              {t(secrets.error)}
            </p>
          )}
          <Pages previous={secrets.previous} next={secrets.next} busy={secrets.loading} />
        </section>
      )}
      {(!!accounts.items.length || accounts.error) && (
        <section className={styles.section}>
          <h2>{t("credentials.title")}</h2>
          <div className={styles.card}>
            {accounts.items.map((account) => (
              <div key={account.id} className={styles.cardRow}>
                <IconTile icon="user" tone="blue" size="lg" />
                <span className={styles.rowText}>
                  <strong>{account.label}</strong>
                  <small>
                    {account.site}
                    {account.hasTotp ? ` · ${t("credentials.totpEnabled")}` : ""}
                  </small>
                </span>
              </div>
            ))}
          </div>
          {accounts.error && (
            <p role="alert" className={styles.error}>
              {t("credentials.loadError")}
            </p>
          )}
          {accounts.hasMore && (
            <Button
              variant="ghost"
              loading={accounts.loading}
              onClick={() => void accounts.load(true)}
            >
              {t("credentials.loadMore")}
            </Button>
          )}
        </section>
      )}
    </>
  );
}
function Pages({
  previous,
  next,
  busy,
}: {
  previous?: () => void;
  next?: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <div>
      {previous && (
        <Button variant="ghost" disabled={busy} onClick={previous}>
          {t("connectors.previous")}
        </Button>
      )}
      {next && (
        <Button variant="ghost" disabled={busy} onClick={next}>
          {t("connectors.more")}
        </Button>
      )}
    </div>
  );
}
