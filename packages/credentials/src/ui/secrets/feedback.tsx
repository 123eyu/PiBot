import type { TranslationKey } from "@pibot/i18n";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "./secrets.module.css";

export function SecretFeedback({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error?: TranslationKey;
  retry(): void;
}) {
  const t = useT();
  return (
    <>
      {loading && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {error && (
        <div role="alert" className={styles.error}>
          {t(error)}{" "}
          <Button variant="secondary" onClick={retry}>
            {t("common.retry")}
          </Button>
        </div>
      )}
    </>
  );
}
export function SecretPagination({
  previous,
  next,
  disabled,
}: {
  previous?: () => void;
  next?: () => void;
  disabled: boolean;
}) {
  const t = useT();
  if (!previous && !next) return null;
  return (
    <div className={styles.row}>
      {previous && (
        <Button variant="secondary" disabled={disabled} onClick={previous}>
          {t("connectors.previous")}
        </Button>
      )}
      {next && (
        <Button variant="secondary" disabled={disabled} onClick={next}>
          {t("connectors.more")}
        </Button>
      )}
    </div>
  );
}
