import { CloseButton, type IconName, IconTile, type Tone } from "@pibot/ui";
import { type CSSProperties, type ReactNode, useId } from "react";
import { useT } from "../settings/context.ts";
import styles from "./overlay.module.css";
import { useSettingsDialog } from "./use-settings-dialog.ts";

export function Overlay({
  title,
  close,
  children,
  busy = false,
  icon,
  tone = "neutral",
  footer,
  titleIcon,
}: {
  title: string;
  close(): void;
  children: ReactNode;
  busy?: boolean;
  /** The title's leading tile; its tone also washes the top (else the page's tone does). */
  icon?: IconName;
  titleIcon?: ReactNode;
  tone?: Tone;
  /** The dialog's action buttons, kept bottom-right and in view while the body scrolls. */
  footer?: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const modal = useSettingsDialog(close);
  const wash =
    icon && tone !== "neutral"
      ? ({
          "--page-c": tone === "red" ? "var(--danger)" : `var(--avatar-${tone})`,
        } as CSSProperties)
      : undefined;
  return (
    <dialog
      ref={modal.dialog}
      aria-labelledby={id}
      className={styles.dialog}
      style={wash}
      data-closing={modal.closing || undefined}
      onKeyDown={modal.trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) modal.close();
      }}
    >
      <header className={styles.header}>
        {titleIcon ?? (icon && <IconTile icon={icon} tone={tone} />)}
        <h1 id={id}>{title}</h1>
        <CloseButton label={t("workspace.close")} disabled={busy} onClick={modal.close} />
      </header>
      <div className={styles.body}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </dialog>
  );
}
