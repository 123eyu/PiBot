import { BotAvatar, useT } from "@pibot/renderer-kit";
import { TextField } from "@pibot/ui";
import styles from "./new-chat.module.css";
import type { NewGroupState } from "./use-new-group.ts";

export function NewChatGroupForm({ state, id }: { state: NewGroupState; id: string }) {
  const t = useT();
  return (
    <form
      id={id}
      className={`${styles.formCard} ${styles.groupAccent}`}
      aria-label={t("workspace.group")}
      onSubmit={(event) => {
        event.preventDefault();
        state.createGroup();
      }}
    >
      <h2 className={styles.cardTitle}>{t("workspace.groupIdentity")}</h2>
      <TextField
        label={t("workspace.groupName")}
        placeholder={t("workspace.groupExample")}
        value={state.groupName}
        maxLength={200}
        disabled={state.task.busy}
        onChange={(event) => state.setGroupName(event.currentTarget.value)}
      />
      <p className={styles.note}>{t("media.coordinator")}</p>
      <fieldset className={styles.coordinators} disabled={state.task.busy}>
        <legend>{t("workspace.coordinator")}</legend>
        {state.coordinators.map((bot) => (
          <label className={styles.choice} key={bot.id}>
            <input
              type="radio"
              name={`${id}-coordinator`}
              checked={state.coordinatorId === bot.id}
              onChange={() => state.setCoordinator(bot.id)}
            />
            <BotAvatar bot={bot} size={28} />
            <span>{bot.name}</span>
          </label>
        ))}
      </fieldset>
    </form>
  );
}
