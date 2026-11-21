import { SettingsLine, SettingsRow, useT } from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import styles from "../settings/remote.module.css";
import { useOfflineModels } from "./use-offline-models.ts";

/**
 * Under a phone on the Devices page, each Bot's 「离线可用」 switch (on by default) and the
 * models whose config and key follow those Bots to the phone automatically (maintainers 2026-11-12:
 * 自动同步，保留每个 Bot 的开关).
 */
export function OfflineModels({ deviceId, disabled }: { deviceId: string; disabled: boolean }) {
  const t = useT();
  const data = useOfflineModels(deviceId);
  const view = data.view;
  const busy = disabled || data.saving || !view;
  return (
    <div className={styles.endpointCard}>
      <h3>{t("remote.offline.title")}</h3>
      <SettingsLine>{t("remote.offline.note")}</SettingsLine>
      {data.failed && (
        <SettingsLine
          role="alert"
          tone="danger"
          action={
            <Button variant="secondary" onClick={() => void data.reload()}>
              {t("remote.retry")}
            </Button>
          }
        >
          {t("remote.cap.loadFailed")}
        </SettingsLine>
      )}
      {data.saveFailed && (
        <SettingsLine role="alert" tone="danger">
          {t("remote.cap.saveFailed")}
        </SettingsLine>
      )}
      {!view && !data.failed && <SettingsLine role="status">{t("remote.loading")}</SettingsLine>}
      {view && !view.models.length && <SettingsLine>{t("remote.offline.noModels")}</SettingsLine>}
      {view && view.bots.length > 0 && (
        <h4 className={styles.subhead}>{t("remote.offline.bots")}</h4>
      )}
      {view?.bots.map((bot) => (
        <SettingsRow
          key={bot.botId}
          label={bot.name}
          note={
            bot.modelName
              ? t("remote.offline.botModel", { model: bot.modelName })
              : t("remote.offline.botNoModel")
          }
        >
          <div className={styles.actions}>
            {/* A Bot whose model cannot go to a phone has nothing to switch; its saved choice stays. */}
            <Switch
              label={t("remote.offline.botToggle", { name: bot.name })}
              checked={bot.offline && !!bot.modelName}
              disabled={busy || !bot.modelName}
              onCheckedChange={(checked) => void data.setBot(bot.botId, checked)}
            />
          </div>
        </SettingsRow>
      ))}
      {view && view.models.length > 0 && (
        <>
          <h4 className={styles.subhead}>{t("remote.offline.providers")}</h4>
          {[
            ...new Map(
              view.models.map((model) => [model.providerId, model.providerName]),
            ).entries(),
          ].map(([providerId, providerName]) => {
            const models = view.models.filter((model) => model.providerId === providerId);
            const unavailable = models.find((model) => model.unavailable)?.unavailable;
            return (
              <SettingsRow
                key={providerId}
                dot={unavailable ? "warn" : "ok"}
                label={providerName}
                note={`${models.length} ${t("remote.offline.modelsCount")} · ${unavailable ? t(`remote.offline.unavailable.${unavailable}`) : t("remote.offline.synced")}`}
              />
            );
          })}
        </>
      )}
    </div>
  );
}
