import { botPanelStyles as styles, useSettings } from "@pibot/renderer-kit";
import { IconTile } from "@pibot/ui";
import { useRef, useState } from "react";
import { InlineBotField } from "../new-chat/InlineBotField.tsx";

export function BotLogRetention({ botId }: { botId: string }) {
  const { settings, update, t } = useSettings();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const value = settings?.commandLogRetention?.[botId] ?? { days: 30, megabytes: 200 };
  const save = async (key: "days" | "megabytes", raw: string) => {
    if (saving.current) return false;
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1 || number > (key === "days" ? 3650 : 10000))
      return false;
    saving.current = true;
    setBusy(true);
    try {
      await update({
        commandLogRetention: {
          ...settings?.commandLogRetention,
          [botId]: { ...value, [key]: number },
        },
      });
      return true;
    } catch {
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <section className={styles.section}>
      <h2>{t("workspace.commandLogRetention")}</h2>
      <div className={styles.card}>
        <div className={styles.cardRow}>
          <IconTile icon="clock" tone="teal" size="lg" />
          <span className={styles.rowText}>
            <strong>{t("workspace.commandLogDays")}</strong>
          </span>
          <span className={styles.numberCell}>
            <InlineBotField
              className={styles.numberField}
              label={t("workspace.commandLogDays")}
              value={String(value.days)}
              disabled={!settings || busy}
              maxLength={4}
              save={(raw) => save("days", raw)}
            />
          </span>
        </div>
        <div className={styles.cardRow}>
          <IconTile icon="box" tone="green" size="lg" />
          <span className={styles.rowText}>
            <strong>{t("workspace.commandLogMegabytes")}</strong>
          </span>
          <span className={styles.numberCell}>
            <InlineBotField
              className={styles.numberField}
              label={t("workspace.commandLogMegabytes")}
              value={String(value.megabytes)}
              disabled={!settings || busy}
              maxLength={5}
              save={(raw) => save("megabytes", raw)}
            />
          </span>
        </div>
      </div>
      <p className={styles.note}>{t("workspace.commandLogRetentionNote")}</p>
    </section>
  );
}
