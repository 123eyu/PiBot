import { ConnectorManifestSchema } from "@pibot/plugins-contract/full";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useEffect, useId, useState } from "react";
import { ConnectorPanel } from "../page/ConnectorPanel.tsx";
import styles from "../page/connectors.module.css";

/** Both hand-written forms and JSON imports go through the same preview contract. */
export function CustomMcp({ close, preview }: { close(): void; preview(json: string): void }) {
  const t = useT();
  const id = useId();
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [auth, setAuth] = useState<"none" | "bearer" | "oauth">("none");
  const [secret, setSecret] = useState("");
  // Maintainers 2026-11-01: pick a saved access token instead of typing its name; typing stays possible.
  const { peer } = useRpc();
  const [tokens, setTokens] = useState<string[]>();
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (auth !== "bearer" || !peer || tokens) return;
    const controller = new AbortController();
    peer
      .call("secrets.list", { limit: 50 }, { signal: controller.signal })
      .then((page) => {
        const names = page.items.filter((item) => item.hasValue).map((item) => item.name);
        setTokens(names);
        setSecret((current) => current || names[0] || "");
      })
      // Without the list the name can still be typed.
      .catch(() => setTokens([]));
    return () => controller.abort();
  }, [auth, peer, tokens]);
  const [args, setArgs] = useState("[]");
  const [env, setEnv] = useState("{}");
  const [domains, setDomains] = useState("");
  const [error, setError] = useState(false);
  const submit = () => {
    setError(false);
    try {
      const server =
        transport === "http"
          ? {
              id: "server",
              transport,
              url: target,
              auth: { kind: auth, secretNames: auth === "bearer" ? [secret] : [] },
              headers:
                auth === "bearer" ? { Authorization: `Bearer ${"${secret:"}${secret}}` } : {},
              networkDomains: [],
            }
          : {
              id: "server",
              transport,
              command: target,
              args: JSON.parse(args),
              env: JSON.parse(env),
              auth: { kind: "none", secretNames: [] },
              networkDomains: domains.split(/[\s,]+/).filter(Boolean),
            };
      // What it connects to describes the row; never the full URL (query) or command path.
      const summary =
        transport === "http" ? new URL(target).host : (target.split(/[\\/]/).at(-1) ?? target);
      const manifest = ConnectorManifestSchema.parse({
        schemaVersion: 1,
        id: `custom.${crypto.randomUUID()}`,
        version: "1",
        name: { zh: name || target, en: name || target },
        description: { zh: summary, en: summary },
        servers: [server],
      });
      preview(JSON.stringify(manifest));
    } catch {
      setError(true);
    }
  };
  return (
    <ConnectorPanel title={t("connectors.preset.custom")} close={close}>
      <div className={styles.formCard}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t("connectors.connectionMode")}</span>
          <SegmentedControl
            label={t("connectors.connectionMode")}
            value={transport}
            options={(["http", "stdio"] as const).map((kind) => ({
              value: kind,
              label: t(`connectors.transport.${kind}`),
            }))}
            onValueChange={(kind) => {
              setTransport(kind);
              setTarget("");
            }}
          />
        </div>
        <label className={styles.field}>
          {t("connectors.customName")}
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className={styles.field}>
          {t(transport === "http" ? "connectors.customUrl" : "connectors.customCommand")}
          <input
            value={target}
            maxLength={transport === "http" ? 2048 : 256}
            autoComplete="off"
            onChange={(event) => setTarget(event.currentTarget.value)}
          />
        </label>
        {transport === "http" ? (
          <>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t("connectors.customAuth")}</span>
              <SegmentedControl
                label={t("connectors.customAuth")}
                value={auth}
                options={(["none", "bearer", "oauth"] as const).map((kind) => ({
                  value: kind,
                  label: t(`connectors.auth.${kind}`),
                }))}
                onValueChange={setAuth}
              />
            </div>
            {auth === "bearer" &&
              (tokens?.length && !typing ? (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t("connectors.customSecret")}</span>
                  <div className={styles.chipRow}>
                    {tokens.map((token) => (
                      <button
                        key={token}
                        type="button"
                        className={styles.chipButton}
                        data-mono=""
                        aria-pressed={secret === token}
                        onClick={() => setSecret(token)}
                      >
                        {token}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={styles.chipButton}
                      aria-pressed={false}
                      onClick={() => {
                        setTyping(true);
                        setSecret("");
                      }}
                    >
                      {t("connectors.customSecretOther")}
                    </button>
                  </div>
                </div>
              ) : (
                <label className={styles.field} htmlFor={`${id}-secret`}>
                  {t("connectors.customSecret")}
                  <input
                    id={`${id}-secret`}
                    value={secret}
                    maxLength={64}
                    autoComplete="off"
                    placeholder="GITHUB_TOKEN"
                    onChange={(event) => setSecret(event.currentTarget.value)}
                  />
                  {tokens && !tokens.length && (
                    <span className={styles.note}>{t("connectors.customSecretNone")}</span>
                  )}
                </label>
              ))}
          </>
        ) : (
          <>
            <label className={styles.field}>
              {t("connectors.customArgs")}
              <textarea
                rows={3}
                value={args}
                maxLength={262144}
                onChange={(event) => setArgs(event.currentTarget.value)}
              />
            </label>
            <label className={styles.field}>
              {t("connectors.customEnv")}
              <textarea
                rows={4}
                value={env}
                maxLength={262144}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setEnv(event.currentTarget.value)}
              />
            </label>
            <label className={styles.field}>
              {t("connectors.network")}
              <input
                value={domains}
                maxLength={4096}
                onChange={(event) => setDomains(event.currentTarget.value)}
              />
            </label>
            <p className={styles.note}>{t("connectors.customNetworkHint")}</p>
          </>
        )}
      </div>
      <p className={styles.note}>{t("connectors.customPreviewHint")}</p>
      {error && (
        <p role="alert" className={styles.error}>
          {t("connectors.invalid")}
        </p>
      )}
      <div className={styles.row}>
        <Button variant="secondary" onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button disabled={!target.trim()} onClick={submit}>
          {t("connectors.preview")}
        </Button>
      </div>
    </ConnectorPanel>
  );
}
