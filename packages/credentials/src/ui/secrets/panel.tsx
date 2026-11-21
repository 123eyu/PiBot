import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { type ReactNode, useEffect, useId, useRef } from "react";
import styles from "./secrets.module.css";

/**
 * 访问令牌: forms open inside the tokens dialog in place of the list (design ②), not as a
 * second sheet. Escape goes back to the list instead of closing the whole dialog.
 */
export function SecretPanelShell({
  title,
  children,
  close,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  close(): void;
  busy?: boolean;
}) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section
      className={styles.inlinePanel}
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // preventDefault keeps the dialog's cancel event from firing for this key press.
        event.preventDefault();
        event.stopPropagation();
        if (!busy) close();
      }}
    >
      <header className={styles.inlineHeader}>
        <Button variant="ghost" disabled={busy} onClick={close}>
          ← {t("connectors.secrets.back")}
        </Button>
        <h2 id={id} ref={heading} tabIndex={-1}>
          {title}
        </h2>
      </header>
      {children}
    </section>
  );
}
