import type { BuiltinApp, Connector } from "@pibot/plugins-contract/full";
import { useSettings } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useState } from "react";
import { ConnectorPanel } from "../page/ConnectorPanel.tsx";
import styles from "../page/connectors.module.css";
import { useConnectorAction } from "../shell/remote.ts";

/** The trusted app catalog supplies modes and help; tokens stay in this local form. */
export function AppSetup({
  app,
  close,
  changed,
  connected,
}: {
  app: BuiltinApp;
  close(): void;
  changed(): void;
  connected(connector: Connector): void;
}) {
  const { t, language } = useSettings();
  const [modeId, setModeId] = useState(app.modes[0]?.id);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const mode = app.modes.find((row) => row.id === modeId);
  const gmailPassword = app.id === "gmail" && modeId === "app-password";
  const incomplete =
    (mode?.auth === "bearer" && !token.trim()) ||
    (gmailPassword &&
      (!/^[^\s@]+@[^\s@]+$/.test(email.trim()) ||
        !/^[A-Za-z0-9]{16}$/.test(token.replace(/ /g, ""))));
  const action = useConnectorAction(changed);
  const connect = async () => {
    if (!mode || !app.supported || incomplete) return;
    const submitted = gmailPassword ? token.replace(/ /g, "") : token.trim();
    setToken("");
    // The host may wait 630 seconds for native consent; both UI deadlines must outlive it.
    const timeoutMs = 660_000;
    const result = await action.run(async (peer, signal) => {
      return await peer.call(
        "apps.connect",
        {
          appId: app.id,
          mode: mode.id,
          // OAuth apps are started before the host's user-only authorize path invokes their
          // fixed oauthStartTool; this keeps the setup button a single action.
          // OAuth is enabled by the user-only authorize path below, after installation.
          enable: true,
          ...(submitted ? { token: submitted } : {}),
          ...(gmailPassword ? { email: email.trim() } : {}),
        },
        { signal, timeoutMs },
      );
    }, timeoutMs);
    if (result?.connectors[0]) connected(result.connectors[0]);
  };
  return (
    <ConnectorPanel title={app.name[language]} close={close} busy={action.busy}>
      <p className={styles.note}>{app.description[language]}</p>
      {!app.supported && (
        <p role="alert" className={styles.warn}>
          {t("connectors.appUnsupported")}
        </p>
      )}
      {app.modes.length > 1 && (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t("connectors.connectionMode")}</span>
          <SegmentedControl
            label={t("connectors.connectionMode")}
            value={modeId ?? ""}
            options={app.modes.map((item) => ({
              value: item.id,
              label: item.capability[language],
            }))}
            disabled={action.disabled}
            onValueChange={(value) => {
              setModeId(value);
              setToken("");
            }}
          />
        </div>
      )}
      {mode && (
        <>
          <p>{mode.capability[language]}</p>
          <p className={styles.note}>{mode.help[language]}</p>
          {gmailPassword && (
            <label className={styles.field}>
              {t("connectors.gmailEmail")}
              <input
                type="email"
                value={email}
                maxLength={320}
                autoComplete="email"
                disabled={action.disabled}
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
            </label>
          )}
          {mode.auth === "bearer" && (
            <label className={styles.field}>
              {t(gmailPassword ? "connectors.gmailAppPassword" : "connectors.appToken")}
              <input
                type="password"
                value={token}
                autoComplete="new-password"
                maxLength={16384}
                disabled={action.disabled}
                onChange={(event) => setToken(event.currentTarget.value)}
              />
            </label>
          )}
          {mode.auth === "oauth" && <p className={styles.note}>{t("connectors.oauthNote")}</p>}
          {action.error && (
            <p role="alert" className={styles.error}>
              {t(action.error)}
            </p>
          )}
          <div className={styles.row}>
            <Button variant="secondary" disabled={action.busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={action.busy}
              disabled={action.disabled || !app.supported || incomplete}
              onClick={() => void connect()}
            >
              {t("connectors.connect")}
            </Button>
          </div>
        </>
      )}
    </ConnectorPanel>
  );
}
