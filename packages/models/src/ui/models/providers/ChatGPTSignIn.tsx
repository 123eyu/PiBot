import { CHATGPT_CODEX_PROVIDER, type Provider } from "@pibot/models-contract/full";
import { setupStyles as styles, TaskStatus, useRpc, useT, useTask } from "@pibot/renderer-kit";
import { Button, Chip, IconTile, TextField } from "@pibot/ui";
import { type ReactNode, useState } from "react";
import { requirePeer, writeCredential } from "../../setup/operations.ts";
import css from "./plan-signin.module.css";
import { useChatGPTLogin } from "./use-chatgpt-login.ts";

// OpenAI's page for a plan's per-app limits (also what pi links on a usage-limit error).
const USAGE_URL = "https://chatgpt.com/settings/usage";

/**
 * Sign in with ChatGPT for the ChatGPT plan provider (OpenAI's UI/UX guidelines; its own
 * provider under 订阅 since 2026-11-15): "Continue with ChatGPT", a first-use explanation
 * of what is sent to whom, the signed-in account, and the usage-limit notice. While this release's
 * gate is closed the card only says the open-source release provides it.
 *
 * Settings (the plan's provider page) and the welcome flow share this card, so both entry points
 * use one sign-in flow and one state; each passes `lead` to replace the header, since its own
 * heading or route card already names the plan.
 */
export function ChatGPTSignIn({
  provider,
  refresh,
  lead,
}: {
  provider: Provider;
  refresh(): Promise<void>;
  lead?: ReactNode;
}) {
  const t = useT();
  const { peer } = useRpc();
  const task = useTask("chatgpt");
  const info = provider.chatgpt;
  const providerId = provider.id;
  // The legacy Codex sign-in says what it is: it signs in as the Codex CLI (maintainers 2026-11-15).
  const codex = providerId === CHATGPT_CODEX_PROVIDER;
  const login = useChatGPTLogin(providerId, !!info?.available, info?.state ?? "disconnected");
  const [explaining, setExplaining] = useState(false);
  const [pasted, setPasted] = useState("");
  if (!info) return null;
  const { state, error } = login.state;
  const connected = state === "connected";
  const disabled = task.busy || task.blocked || !peer;
  const run = (action: () => Promise<void>) =>
    void task.run(async () => {
      await action();
      await refresh();
    });
  const start = () =>
    void task.run(async () => {
      setExplaining(false);
      await login.apply(() =>
        writeCredential(() => requirePeer(peer).call("providers.login", { providerId })),
      );
    });
  const usage = (
    <a className={css.link} href={USAGE_URL} target="_blank" rel="noreferrer">
      {t("chatgpt.manageUsage")}
    </a>
  );
  return (
    <aside aria-label={t(codex ? "chatgpt.codex.title" : "chatgpt.title")} className={styles.stack}>
      {lead ?? (
        <div className={css.head}>
          <IconTile icon="user" tone="green" />
          <div>
            <strong>{t(codex ? "chatgpt.codex.title" : "chatgpt.title")}</strong>
            <p className={styles.note}>{t(codex ? "chatgpt.codex.intro" : "chatgpt.intro")}</p>
          </div>
          {!info.available ? (
            <Chip>{t("chatgpt.openSource")}</Chip>
          ) : connected ? (
            <Chip tone="ok">{t("auth.state.connected")}</Chip>
          ) : state === "connecting" ? (
            <Chip tone="blue">{t("auth.state.connecting")}</Chip>
          ) : null}
        </div>
      )}
      {!info.available ? (
        <>
          <p className={styles.note}>{t("chatgpt.openSourceNote")}</p>
          <div className={css.actions}>
            <Button disabled title={t("chatgpt.openSource")}>
              {t("chatgpt.continue")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <TaskStatus task={task} />
          {info.usageLimited && connected && (
            // No auth switch any more: OpenAI's API key is another provider a Bot can pick.
            <div className={css.band} data-tone="danger" role="status">
              <strong>{t("chatgpt.limit.title")}</strong>
              <p>{t("chatgpt.limit.body")}</p>
              <div className={css.actions}>{usage}</div>
            </div>
          )}
          {state === "reauthRequired" && (
            <p className={css.band} data-tone="warn" role="status">
              {t("chatgpt.reauth")}
            </p>
          )}
          {state === "error" && (
            <p className={css.band} data-tone="danger" role="alert">
              {t(`chatgpt.error.${error ?? "internal"}`)}
            </p>
          )}
          {connected && (
            <div className={css.account}>
              <IconTile icon="check" tone="green" size="sm" />
              <span>
                {info.account
                  ? t("chatgpt.signedIn", { account: info.account })
                  : t("chatgpt.signedInNoAccount")}
              </span>
            </div>
          )}
          {explaining && (
            <div className={css.band} role="dialog" aria-label={t("chatgpt.firstUse.title")}>
              <strong>{t("chatgpt.firstUse.title")}</strong>
              <p>{t(codex ? "chatgpt.codex.firstUse" : "chatgpt.firstUse.body")}</p>
              <div className={css.actions}>
                <Button disabled={disabled} onClick={start}>
                  {t("chatgpt.firstUse.confirm")}
                </Button>
                <Button variant="ghost" onClick={() => setExplaining(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
          {state === "connecting" ? (
            <>
              <p role="status">{t("chatgpt.browser")}</p>
              {login.step?.kind === "manual_code" && (
                <details className={css.manual}>
                  <summary>{t("chatgpt.manual")}</summary>
                  <form
                    className={styles.stack}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = pasted;
                      setPasted("");
                      void task.run(() => login.input(value));
                    }}
                  >
                    <p className={styles.note}>{t("chatgpt.manualHint")}</p>
                    <TextField
                      label={t("chatgpt.manualField")}
                      type="password"
                      autoComplete="off"
                      value={pasted}
                      disabled={disabled}
                      onChange={(event) => setPasted(event.target.value)}
                    />
                    <Button type="submit" variant="secondary" disabled={disabled || !pasted}>
                      {t("chatgpt.manualSubmit")}
                    </Button>
                  </form>
                </details>
              )}
              <div className={css.actions}>
                <Button
                  variant="secondary"
                  disabled={!peer}
                  onClick={() =>
                    void task.run(async () => {
                      await requirePeer(peer).call("providers.cancelLogin", {
                        providerId,
                      });
                    })
                  }
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </>
          ) : (
            !explaining && (
              <div className={css.actions}>
                {!connected && (
                  <Button
                    // The welcome step makes this its main action, full width like its other routes.
                    className={lead ? css.wide : undefined}
                    disabled={disabled}
                    onClick={() => setExplaining(true)}
                  >
                    {t("chatgpt.continue")}
                  </Button>
                )}
                {connected && !info.usageLimited && usage}
                {(connected || state === "reauthRequired") && (
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      run(async () => {
                        await requirePeer(peer).call("providers.logout", {
                          providerId,
                        });
                      })
                    }
                  >
                    {t("chatgpt.disconnect")}
                  </Button>
                )}
              </div>
            )
          )}
        </>
      )}
    </aside>
  );
}
