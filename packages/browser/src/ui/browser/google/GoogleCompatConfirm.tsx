import { useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useState } from "react";
import styles from "../pane/bot-browser.module.css";

/**
 * The in-app confirm before Google compatibility mode turns on. It says plainly that the
 * Bot's browser will present itself as another browser on Google's sites, and nothing else.
 */
export function GoogleCompatConfirm({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "saving" | "failed">("idle");
  const confirm = async () => {
    setStatus("saving");
    try {
      await onConfirm();
    } catch {
      setStatus("failed");
    }
  };
  return (
    <div className={styles.compatConfirm} role="dialog" aria-label={t("googleCompat.title")}>
      <div className={styles.compatHead}>
        <IconTile icon="globe" tone="blue" />
        <strong>{t("googleCompat.confirmTitle", { name })}</strong>
      </div>
      <p>{t("googleCompat.confirmBody", { name })}</p>
      {status === "failed" && <p role="alert">{t("botBrowser.failed")}</p>}
      <div className={styles.dataActions}>
        <Button variant="ghost" disabled={status === "saving"} onClick={onCancel}>
          {t("googleCompat.cancel")}
        </Button>
        <Button loading={status === "saving"} onClick={() => void confirm()}>
          {t("googleCompat.turnOn")}
        </Button>
      </div>
    </div>
  );
}
