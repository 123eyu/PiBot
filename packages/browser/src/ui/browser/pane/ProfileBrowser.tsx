import type { Bot } from "@pibot/browser-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import { botPanelStyles as panelStyles, useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile, Switch } from "@pibot/ui";
import { useState } from "react";
import { GoogleCompatConfirm } from "../google/GoogleCompatConfirm.tsx";
import { useGoogleCompat } from "../google/use-google-compat.ts";
import styles from "./bot-browser.module.css";

type ClearStatus = "idle" | "confirm" | "clearing" | "cleared" | "busy" | "failed";

/**
 * Bot panel「权限」·「浏览器」: this Bot's Google compatibility switch and the
 * wipe of its own browser profile (sign-ins, cookies, storage, cache), one row each. Clearing
 * takes two steps so a stray click cannot log the Bot out of everything; brain writes the audit.
 */
export function ProfileBrowser({
  bot,
  group,
}: { bot: Bot; group?: never } | { group: { id: string; name: string }; bot?: never }) {
  const t = useT();
  const { peer } = useRpc();
  const name = group?.name ?? bot?.name ?? "";
  const compat = useGoogleCompat(peer, bot?.id, group?.id);
  const [confirming, setConfirming] = useState(false);
  const [compatFailed, setCompatFailed] = useState(false);
  const [status, setStatus] = useState<ClearStatus>("idle");
  const turnOff = async () => {
    setCompatFailed(false);
    try {
      await compat.set(false);
    } catch {
      setCompatFailed(true);
    }
  };
  const clear = async () => {
    if (!peer) return;
    setStatus("clearing");
    try {
      await peer.call("browser.clearData", group ? { groupId: group.id } : { botId: bot.id });
      setStatus("cleared");
    } catch (error) {
      setStatus(error instanceof RpcError && error.code === RpcErrorCodes.busy ? "busy" : "failed");
    }
  };
  return (
    <section className={panelStyles.section}>
      <h2>{t("panel.browser")}</h2>
      <div className={panelStyles.card}>
        {compat.state && (
          <div className={panelStyles.cardRow}>
            <IconTile icon="globe" tone="blue" size="lg" />
            <span className={panelStyles.rowText}>
              <strong>{t("googleCompat.title")}</strong>
              <small>{t("panel.googleCompatNote")}</small>
            </span>
            <Switch
              label={t("googleCompat.title")}
              checked={compat.state.enabled}
              disabled={confirming || compat.busy}
              onCheckedChange={(next) => {
                if (next) setConfirming(true);
                else void turnOff();
              }}
            />
          </div>
        )}
        <div className={panelStyles.cardRow}>
          <IconTile icon="box" tone="teal" size="lg" />
          <span className={panelStyles.rowText}>
            <strong>{t("panel.browserData")}</strong>
            <small>{t("panel.browserDataNote")}</small>
          </span>
          <Button
            variant="pill"
            className={`${panelStyles.menuTrigger} ${panelStyles.danger}`}
            disabled={!peer || status === "confirm" || status === "clearing"}
            onClick={() => setStatus("confirm")}
          >
            {t("botBrowser.data.clear")}
          </Button>
        </div>
      </div>
      {confirming && (
        <GoogleCompatConfirm
          name={name}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await compat.set(true);
            setConfirming(false);
          }}
        />
      )}
      {compat.loading && (
        <p role="status" className={panelStyles.note}>
          {t("common.loading")}
        </p>
      )}
      {compat.error && (
        <p role="alert" className={panelStyles.error}>
          {t("botBrowser.failed")}{" "}
          <Button variant="pill" onClick={compat.refresh}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {compatFailed && (
        <p role="alert" className={panelStyles.error}>
          {t("botBrowser.failed")}
        </p>
      )}
      {(status === "confirm" || status === "clearing") && (
        <div className={panelStyles.proposal}>
          <p>{t("botBrowser.data.confirm", { name })}</p>
          <div className={styles.dataActions}>
            <Button
              variant="ghost"
              className={panelStyles.smallPill}
              disabled={status === "clearing"}
              onClick={() => setStatus("idle")}
            >
              {t("botBrowser.data.cancel")}
            </Button>
            <Button
              variant="ghost"
              className={`${panelStyles.smallPill} ${panelStyles.danger}`}
              loading={status === "clearing"}
              onClick={() => void clear()}
            >
              {t("botBrowser.data.confirmButton")}
            </Button>
          </div>
        </div>
      )}
      {status === "cleared" && (
        <p role="status" className={panelStyles.note}>
          {t("botBrowser.data.cleared")}
        </p>
      )}
      {(status === "busy" || status === "failed") && (
        <p role="alert" className={panelStyles.error}>
          {t(status === "busy" ? "botBrowser.data.busy" : "botBrowser.failed")}
        </p>
      )}
    </section>
  );
}
