import type { Bot } from "@pibot/protocol";
import {
  avatarColors,
  avatarEyes,
  avatarShapes,
  BotAvatar,
  botAvatarLook,
  botPanelStyles as styles,
  useT,
} from "@pibot/renderer-kit";
import type { CSSProperties } from "react";
import { AvatarUpload } from "../../app-menu/AvatarUpload.tsx";

/**
 * One soft card under the big avatar — 形状 as mini avatars,
 * 颜色 as round swatches, 眼睛 as mini avatars; the chosen one is ringed in the Bot's ink colour.
 * Each click saves at once, as before.
 */
export function AvatarPicker({
  bot,
  change,
  disabled,
}: {
  bot: Bot;
  disabled: boolean;
  change(bot: Bot): Promise<boolean>;
}) {
  const t = useT();
  const ink = `var(--ink-${botAvatarLook(bot).color})`;
  const groups = [
    { title: "workspace.shape" as const, field: "avatarShape" as const, options: avatarShapes },
    { title: "workspace.color" as const, field: "avatarColor" as const, options: avatarColors },
    { title: "workspace.eyes" as const, field: "avatarEyes" as const, options: avatarEyes },
  ];
  return (
    <section
      className={styles.avatarCard}
      aria-label={t("workspace.avatar")}
      style={{ "--avatar-ring": ink } as CSSProperties}
    >
      <strong>{t("workspace.avatar")}</strong>
      <AvatarUpload
        image={bot.avatarImage}
        disabled={disabled}
        change={(avatarImage) => change({ ...bot, avatarImage })}
      />
      {groups.map((group) => (
        <div key={group.field} className={styles.avatarGroup}>
          <span className={styles.avatarGroupTitle}>{t(group.title)}</span>
          <div className={styles.avatarChoices} data-kind={group.field}>
            {group.options.map((value, index) => (
              <button
                key={value}
                type="button"
                className={styles.avatarChoice}
                aria-label={`${t(group.title)} ${index + 1}`}
                aria-pressed={bot[group.field] === value}
                disabled={disabled}
                onClick={() => void change({ ...bot, avatarImage: null, [group.field]: value })}
              >
                {group.field === "avatarColor" ? (
                  <span
                    className={styles.avatarSwatch}
                    style={{ background: `var(--avatar-${value})` }}
                  />
                ) : (
                  <BotAvatar
                    bot={{ ...bot, avatarImage: null, [group.field]: value }}
                    size={34}
                    label={`${t(group.title)} ${index + 1}`}
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
