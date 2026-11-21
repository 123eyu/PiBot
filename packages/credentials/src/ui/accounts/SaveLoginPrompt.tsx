import { type CredentialCapture, credentialSiteLabel } from "@pibot/credentials-contract/full";
import { useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "./credentials.module.css";
import { useBrowserBots, useCredentialStatus } from "./use-credentials.ts";

/**
 * After the user hands a Bot's browser back, "save this account?" for a login form
 * they submitted during the takeover. Placed at the bottom of the browser pane: it is where the
 * user just was, and it belongs to that Bot's browser rather than to one chat message (group
 * chats, a scrolled history). Only the site and username reach this window; the password stays
 * in the background process until "Save", and "Don't save" discards it there.
 */
export function SaveLoginPrompt({ botId }: { botId: string }) {
  const { peer } = useRpc();
  const t = useT();
  const bots = useBrowserBots();
  const status = useCredentialStatus();
  const [capture, setCapture] = useState<CredentialCapture | null>(null);
  const [botIds, setBotIds] = useState<string[]>([botId]);
  const [busy, setBusy] = useState<"save" | "dismiss">();
  const [result, setResult] = useState<"saved" | "failed">();
  useEffect(() => {
    if (!peer) return;
    let alive = true;
    void peer
      .call("credentials.capture.get", { botId })
      .then((value) => {
        if (alive) setCapture(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [peer, botId]);
  useRpcEvent("credentials.capture", (payload) => {
    if (payload.botId !== botId) return;
    setCapture(payload.capture);
    setBotIds([botId]);
    if (payload.capture) setResult(undefined);
  });
  useEffect(() => {
    if (result !== "saved") return;
    const timer = setTimeout(() => setResult(undefined), 6000);
    return () => clearTimeout(timer);
  }, [result]);
  if (!capture)
    return result === "saved" ? (
      <p role="status" className={styles.prompt}>
        {t("credentials.capture.saved")}
      </p>
    ) : null;
  const answer = async (save: boolean) => {
    if (!peer || busy) return;
    setBusy(save ? "save" : "dismiss");
    try {
      await peer.call(
        "credentials.capture.resolve",
        { botId, captureId: capture.captureId, save, ...(save ? { botIds } : {}) },
        { timeoutMs: 40_000 },
      );
      setCapture(null);
      setResult(save ? "saved" : undefined);
    } catch {
      setResult("failed");
    } finally {
      setBusy(undefined);
    }
  };
  const canSave = status?.storage !== false;
  return (
    <section className={styles.prompt} aria-label={t("credentials.capture.title")}>
      <div className={styles.promptHead}>
        <IconTile icon="user" tone="blue" className={styles.chatTile} />
        <strong>{t("credentials.capture.title")}</strong>
      </div>
      <p>
        {t("credentials.capture.body", {
          site: credentialSiteLabel(capture.site),
          account: capture.username
            ? t("credentials.capture.account", { username: capture.username })
            : "",
        })}
      </p>
      {bots.length > 1 && (
        <fieldset className={styles.bots}>
          <legend>{t("credentials.capture.for")}</legend>
          {bots.map((bot) => (
            <label key={bot.id}>
              <input
                type="checkbox"
                checked={botIds.includes(bot.id)}
                disabled={!!busy}
                onChange={(event) =>
                  setBotIds((old) =>
                    event.currentTarget.checked
                      ? [...old, bot.id]
                      : old.filter((id) => id !== bot.id),
                  )
                }
              />
              {bot.name}
            </label>
          ))}
        </fieldset>
      )}
      {!canSave && (
        <p role="alert" className={styles.hint}>
          {t("credentials.storageUnavailable")}
        </p>
      )}
      {result === "failed" && <p role="alert">{t("credentials.capture.failed")}</p>}
      <div className={styles.promptActions}>
        <Button
          variant="secondary"
          loading={busy === "dismiss"}
          disabled={!peer || !!busy}
          onClick={() => void answer(false)}
        >
          {t("credentials.capture.dismiss")}
        </Button>
        <Button
          className={styles.save}
          loading={busy === "save"}
          disabled={!peer || !!busy || !canSave}
          onClick={() => void answer(true)}
        >
          {t("credentials.capture.save")}
        </Button>
      </div>
    </section>
  );
}
