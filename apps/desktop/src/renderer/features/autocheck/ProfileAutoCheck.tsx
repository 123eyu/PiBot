import type { Bot } from "@pibot/protocol";
import { botPanelStyles as styles, useAction, useRpc, useT } from "@pibot/renderer-kit";
import { useBuiltinCatalog } from "@pibot/teams/ui";
import { IconTile, Switch } from "@pibot/ui";
import { useAutoCheck } from "./use-auto-check.ts";

/** Automatic checks belong to the Bot; the header menu now contains conversation actions. */
export function ProfileAutoCheck({ bot }: { bot: Bot }) {
  const t = useT();
  const { peer } = useRpc();
  const check = useAutoCheck(bot.category === "image" ? null : peer, bot.id, undefined);
  const { catalog } = useBuiltinCatalog(!!bot.role && bot.category !== "image");
  const action = useAction();
  const role = bot.role ? catalog?.roles.find((item) => item.id === bot.role?.id) : undefined;
  if (!check.settings || (!role?.autoCheck && !check.settings.enabled)) return null;
  return (
    <section className={styles.section}>
      <div className={styles.row}>
        <IconTile icon="check" tone="teal" size="lg" />
        <span>{t("autoCheck.title")}</span>
        <Switch
          label={t("autoCheck.title")}
          checked={check.settings.enabled}
          disabled={action.busy}
          onCheckedChange={(enabled) =>
            void action.run(
              () => check.set({ enabled }),
              () => "autoCheck.failed",
            )
          }
        />
      </div>
      <p className={styles.note}>{t("panel.autoCheckNote", { name: bot.name })}</p>
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </section>
  );
}
