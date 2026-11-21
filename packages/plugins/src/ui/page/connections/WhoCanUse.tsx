import { useT } from "@pibot/renderer-kit";
import type { ComponentProps, ReactNode } from "react";
import styles from "./connections.module.css";
import { FacePicker } from "./Faces.tsx";

export function WhoCanUse({
  children,
  ...picker
}: ComponentProps<typeof FacePicker> & { children?: ReactNode }) {
  const t = useT();
  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle} data-mark="violet">
        <span>{t("connections.panel.who")}</span>
      </h3>
      <div className={styles.softCard}>
        <div className={styles.tileRow}>
          <FacePicker {...picker} />
        </div>
      </div>
      <p className={styles.quiet}>{t("connections.panel.whoNote")}</p>
      {children}
    </section>
  );
}
