import type { Message } from "@pibot/protocol";
import { useSettings, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { Markdown } from "./Markdown.tsx";
import { useMessageActions } from "./MessageActionsContext.tsx";
import styles from "./message-actions.module.css";
export function MessageSelectionToggle({ message, name }: { message: Message; name: string }) {
  const actions = useMessageActions(),
    t = useT();
  if (!actions?.selecting || message.status === "streaming" || message.role === "error")
    return null;
  return (
    <button
      type="button"
      className={styles.selectionCheck}
      aria-label={t("messages.select")}
      aria-pressed={actions.selected.has(message.id)}
      onClick={() => actions.toggle(message, name)}
    >
      {actions.selected.has(message.id) && <Icon name="check" size={15} />}
    </button>
  );
}
export function MessageTranslation({ message }: { message: Message }) {
  const actions = useMessageActions(),
    t = useT(),
    { language } = useSettings();
  const translation = actions?.translations.get(message.id);
  if (!actions || !translation || translation.language !== language) return null;
  return (
    <section className={styles.translation} aria-label={t("messages.translation")}>
      <div className={styles.translationHead}>
        <small>{t("messages.translation")}</small>
        <Button variant="ghost" onClick={() => actions.hideTranslation(message.id)}>
          {t("messages.hideTranslation")}
        </Button>
      </div>
      {translation.status === "loading" ? (
        <p role="status">{t("messages.translating")}</p>
      ) : translation.status === "error" ? (
        <p role="alert">
          {t("messages.translateFailed")}{" "}
          <Button variant="ghost" onClick={() => actions.translate(message)}>
            {t("common.retry")}
          </Button>
        </p>
      ) : (
        <Markdown text={translation.text ?? ""} />
      )}
    </section>
  );
}
