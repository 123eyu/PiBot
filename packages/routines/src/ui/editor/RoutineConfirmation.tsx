import { useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useId, useLayoutEffect, useRef } from "react";
import styles from "../shell/routines.module.css";

export function RoutineConfirmation({
  message,
  confirmLabel,
  disabled = false,
  feedback,
  retry,
  retryDisabled = false,
  confirm,
  cancel,
}: {
  message: string;
  confirmLabel: string;
  disabled?: boolean;
  feedback?: string;
  retry?(): void;
  retryDisabled?: boolean;
  confirm(): void;
  cancel(): void;
}) {
  const { t } = useSettings();
  const label = useId();
  const region = useRef<HTMLFieldSetElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    // Destructive confirmation must never receive the initial keyboard action.
    cancelButton.current?.focus({ preventScroll: true });
    region.current?.scrollIntoView({ block: "nearest" });
  }, []);
  useLayoutEffect(() => {
    if (feedback) region.current?.scrollIntoView({ block: "nearest" });
  }, [feedback]);
  return (
    <fieldset
      ref={region}
      className={`${styles.warn} ${styles.confirmation}`}
      aria-labelledby={label}
    >
      <p id={label}>{message}</p>
      {feedback && (
        <p role="alert" className={styles.error}>
          {feedback}
        </p>
      )}
      <div className={styles.row}>
        <Button ref={cancelButton} variant="secondary" onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button disabled={disabled} onClick={confirm}>
          {confirmLabel}
        </Button>
        {retry && (
          <Button variant="secondary" disabled={retryDisabled} onClick={retry}>
            {t("common.retry")}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
