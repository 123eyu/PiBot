import { useT } from "@pibot/renderer-kit";
import { Icon } from "@pibot/ui";
import styles from "../chat.module.css";

export function JumpLatest({
  away,
  newCount,
  jumpLatest,
}: {
  away: boolean;
  newCount: number;
  jumpLatest(): void;
}) {
  const t = useT();
  const title = t("chat.jumpLatest", {
    shortcut: /Mac/i.test(globalThis.navigator?.platform ?? "") ? "⌘↓" : "Ctrl+↓",
  });
  return (
    <button
      type="button"
      className={styles.jumpLatest}
      data-visible={away}
      inert={!away}
      title={title}
      aria-label={newCount ? `${title} · ${t("chat.newMessages", { count: newCount })}` : title}
      onClick={jumpLatest}
    >
      <Icon name="send" size={18} />
      {newCount > 0 && (
        <span className={styles.jumpCount} aria-hidden="true">
          {newCount}
        </span>
      )}
    </button>
  );
}
