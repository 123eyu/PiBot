import type { RoutineLedgerFile, RoutineLedgerInput } from "@pibot/protocol";
import { type Peer, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useState } from "react";
import { useRemote } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";

const fileLine = (file: RoutineLedgerFile) =>
  `${file.path} · ${file.size} B${file.sha256 ? ` · ${file.sha256.slice(0, 12)}` : ""}`;

function inputLine(input: RoutineLedgerInput, t: ReturnType<typeof useSettings>["t"]) {
  if (input.kind === "trigger_file")
    return `${t("routines.ledger.input.trigger")} · ${fileLine(input.file)}`;
  if (input.kind === "existing_output")
    return `${t("routines.ledger.input.existing")} · ${fileLine(input.file)}`;
  if (input.kind === "previous_period")
    return t("routines.ledger.input.previous", {
      period: input.periodKey,
      folder: input.folder,
      count: input.files,
    });
  if (input.kind === "connection_items")
    return t("routines.ledger.input.connection", { count: input.count });
  if (input.kind === "calendar_events")
    return t("routines.ledger.input.calendar", { count: input.count });
  return t("routines.ledger.input.github", { count: input.count });
}

/** What one run processed, produced and sent; loaded only when opened. */
function LedgerBody({ id }: { id: string }) {
  const { t } = useSettings();
  const load = useCallback(
    (peer: Peer, signal: AbortSignal) => peer.call("routines.runLedger", { id }, { signal }),
    [id],
  );
  const ledger = useRemote(load);
  if (ledger.loading) return <p role="status">{t("common.loading")}</p>;
  if (ledger.error || !ledger.value)
    return (
      <p role="alert" className={styles.error}>
        {t(ledger.error ?? "routines.failed")}{" "}
        <Button onClick={ledger.refresh}>{t("common.retry")}</Button>
      </p>
    );
  const value = ledger.value;
  return (
    <div className={styles.stack}>
      <p className={styles.note}>
        {value.outputFolder
          ? t("routines.ledger.folder", {
              period: value.periodKey ?? "",
              folder: value.outputFolder,
            })
          : t(`routines.ledger.noFolder.${value.outputSkipped ?? "disabled"}`)}
      </p>
      {value.attempts.length > 1 && (
        <p className={styles.note}>
          {t("routines.ledger.attempts", {
            index: value.attempts.indexOf(value.routineRunId) + 1,
            count: value.attempts.length,
          })}
        </p>
      )}
      <strong>{t("routines.ledger.inputs")}</strong>
      {value.inputs.length ? (
        <ul>
          {value.inputs.map((input) => (
            <li key={JSON.stringify(input)}>{inputLine(input, t)}</li>
          ))}
        </ul>
      ) : (
        <p className={styles.note}>{t("routines.ledger.none")}</p>
      )}
      <strong>{t("routines.ledger.outputs")}</strong>
      {value.outputs.length ? (
        <ul>
          {value.outputs.map((file) => (
            <li key={file.path}>{fileLine(file)}</li>
          ))}
        </ul>
      ) : (
        <p className={styles.note}>{t("routines.ledger.none")}</p>
      )}
      <strong>{t("routines.ledger.sends")}</strong>
      {value.sends.length ? (
        <ul>
          {value.sends.map((send) => (
            <li key={send.key}>
              {send.tool} → {send.target} · {t(`routines.ledger.delivery.${send.delivery}`)}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.note}>{t("routines.ledger.none")}</p>
      )}
    </div>
  );
}

export function RunLedger({ id }: { id: string }) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.ledger} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t("routines.ledger")}</summary>
      {open && <LedgerBody id={id} />}
    </details>
  );
}
