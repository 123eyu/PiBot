import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "../chat.module.css";

// Shown only when the brain found this topic past the new model's background compaction
// line. 「立即整理」 hands the work to the same CompactionActions row as the + menu (requesting it
// also hides this notice), so the brain-side lease, cancellation, result notice and failure text
// stay in one place instead of being copied here.
export function ContextHintNotice({
  disabled,
  organize,
  dismiss,
}: {
  disabled: boolean;
  organize(): void;
  dismiss(): void;
}) {
  const t = useT();
  return (
    <div className={`${styles.notice} ${styles.band}`} data-tone="info" role="status">
      {t("chat.contextHint")}{" "}
      <Button variant="ghost" disabled={disabled} onClick={organize}>
        {t("chat.compactNow")}
      </Button>
      <Button variant="ghost" onClick={dismiss}>
        {t("chat.contextHintDismiss")}
      </Button>
    </div>
  );
}
