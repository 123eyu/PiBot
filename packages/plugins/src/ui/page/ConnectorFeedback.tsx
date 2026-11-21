import type { TranslationKey } from "@pibot/i18n";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { type OperationRow, operationPending } from "../shell/operations.ts";
import { connectionFailureCode } from "./connection-state.ts";
import styles from "./connectors.module.css";

export function ConnectorFeedback({
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
        <div
          role={error === "connectors.nativeConfirmationWaiting" ? "status" : "alert"}
          className={error === "connectors.nativeConfirmationWaiting" ? styles.note : styles.error}
        >
          {t(error)}{" "}
          <Button variant="secondary" onClick={retry}>
            {t("common.retry")}
          </Button>
        </div>
      )}
    </>
  );
}
export function ConnectorPagination({
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
export function OperationStatus({
  row,
  check,
  systemAuth = false,
}: {
  row?: OperationRow;
  check(): void;
  systemAuth?: boolean;
}) {
  const t = useT();
  if (!row) return null;
  return (
    <div
      role="status"
      className={row.operation?.state === "error" || row.unknown ? styles.error : styles.note}
    >
      {row.unknown ? (
        t("connectors.operationUnknown")
      ) : row.operation ? (
        <>
          {t(`connectors.operation.${row.operation.state}`)}
          {operationPending(row) && <> · {t(`connectors.phase.${row.operation.phase}`)}</>}
          {row.operation.failureCode && (
            <>
              {" "}
              ·{" "}
              {t(
                `connectors.failure.${connectionFailureCode(row.operation.failureCode, systemAuth)}`,
              )}
            </>
          )}
        </>
      ) : (
        t("connectors.operation.pending")
      )}
      {row.unknown && (
        <Button variant="secondary" onClick={check}>
          {t("connectors.checkOperation")}
        </Button>
      )}
    </div>
  );
}
