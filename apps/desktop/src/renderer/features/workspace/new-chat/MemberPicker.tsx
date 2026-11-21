import { avatarColors, BotAvatar, useT } from "@pibot/renderer-kit";
import { Button, Chip, Icon } from "@pibot/ui";
import { type CSSProperties, useId, useRef } from "react";
import styles from "./new-chat.module.css";
import type { NewGroupState } from "./use-new-group.ts";
import { useRecipientKeyboard } from "./use-recipient-keyboard.ts";

/** The group's members: a name filter with the picked chips, then text and image Bots to tick. */
export function MemberPicker({ state }: { state: NewGroupState }) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const keyboard = useRecipientKeyboard(state, input, `${id}-list`);
  const modelNames = new Map(
    state.catalog.models.map((model) => [JSON.stringify([model.provider, model.id]), model.name]),
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Arrow keys move between the field and the options it controls.
    <div className={styles.card} onKeyDown={keyboard.keyDown}>
      <div className={styles.recipients}>
        <Icon name="search" size={15} className={styles.searchIcon} />
        {state.selectedBots.map((bot) => (
          <span key={bot.id} className={styles.chip}>
            <BotAvatar bot={bot} size={22} />
            <span className={styles.chipName}>{bot.name}</span>
            <Button
              variant="ghost"
              className={styles.removeChip}
              disabled={state.task.busy}
              aria-label={t("attachments.remove", { name: bot.name })}
              onClick={() => state.removePicked(bot.id)}
            >
              <Icon name="close" size={12} />
            </Button>
          </span>
        ))}
        <input
          ref={input}
          data-dialog-initial-focus
          className={styles.input}
          role="combobox"
          aria-label={t("workspace.memberSearch")}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-activedescendant={keyboard.active ? keyboard.optionId(keyboard.active) : undefined}
          placeholder={t(state.picked.length ? "workspace.addRecipient" : "workspace.memberSearch")}
          disabled={state.task.busy}
          value={state.query}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => {
            state.setQuery(event.currentTarget.value);
            keyboard.setActiveKey(undefined);
          }}
        />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label={t("workspace.members")}
        aria-multiselectable="true"
        aria-busy={state.task.busy}
        className={styles.list}
      >
        {(
          [
            { label: "media.textBots", bots: state.textBots },
            { label: "media.imageBots", bots: state.imageBots },
          ] as const
        ).map((section) => (
          <div key={section.label} role="presentation">
            <div role="presentation" className={styles.groupHeading}>
              {t(section.label)}
            </div>
            {!section.bots.length && <p className={styles.emptyNote}>{t("combobox.noResults")}</p>}
            {section.bots.map((bot) => {
              const subtitle =
                bot.description?.trim() ||
                modelNames.get(JSON.stringify([bot.modelProvider, bot.modelId])) ||
                t(bot.isMain ? "sidebar.mainBot" : "workspace.dataNoModel");
              const picked = state.picked.includes(bot.id);
              const color = avatarColors.find((value) => value === bot.avatarColor) ?? "violet";
              return (
                <button
                  key={bot.id}
                  type="button"
                  id={keyboard.optionId(bot.id)}
                  role="option"
                  aria-selected={picked}
                  data-active={keyboard.active === bot.id || undefined}
                  data-picked={picked || undefined}
                  tabIndex={keyboard.active === bot.id ? 0 : -1}
                  disabled={keyboard.disabled(bot.id)}
                  className={styles.option}
                  style={{ "--row-c": `var(--avatar-${color})` } as CSSProperties}
                  onFocus={() => keyboard.setActiveKey(bot.id)}
                  onClick={() => keyboard.choose(bot.id)}
                >
                  <span className={styles.avatar}>
                    <BotAvatar bot={bot} size={32} />
                    {bot.isMain && (
                      <span className={styles.mainBadge} title={t("sidebar.mainBot")}>
                        <Icon name="star" size={10} />
                      </span>
                    )}
                  </span>
                  <span className={styles.identity}>
                    <span className={styles.name}>{bot.name}</span>
                    {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
                  </span>
                  {picked && (
                    <Chip tone={bot.id === state.coordinatorId ? "teal" : "neutral"}>
                      {t(bot.id === state.coordinatorId ? "workspace.coordinator" : "group.member")}
                    </Chip>
                  )}
                  <span
                    className={styles.check}
                    data-checked={picked || undefined}
                    aria-hidden="true"
                  >
                    {picked && <Icon name="check" size={13} />}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {!state.filtered.length && !state.data.loading && !!state.query.trim() && (
        <p role="status" className={styles.note}>
          {t(state.data.hasMoreBots ? "workspace.noLoadedBotNamed" : "workspace.noBotNamed", {
            name: state.query.trim(),
          })}
        </p>
      )}
      {state.data.hasMoreBots && (
        <Button
          variant="ghost"
          disabled={state.task.busy || state.data.loading}
          onClick={() => void state.data.moreBots()}
        >
          {t("workspace.more")}
        </Button>
      )}
    </div>
  );
}
