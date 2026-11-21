import type { BackgroundCommand } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button, StatusDot } from "@pibot/ui";
import { BackgroundPortButtons } from "./BackgroundPortButtons.tsx";
import { stoppedReasonKey } from "./background-reason.ts";
import styles from "./execution.module.css";

/** Task rows and completion events share actions with the original tool line. */
export function BackgroundCommandCompact({
  row,
  event,
  now,
  busy,
  stopping,
  act,
  toggleOutput,
}: {
  row: BackgroundCommand;
  event: boolean;
  now: number;
  busy: boolean;
  stopping: boolean;
  act(action: "stop" | "continue" | number): void;
  toggleOutput(): void;
}) {
  const t = useT();
  const running = row.status === "running";
  // The panel row names the stop reason too, not just "Stopped".
  const stoppedReason = stoppedReasonKey(row);
  const warning = row.status === "failed" || (row.exitCode != null && row.exitCode !== 0);
  const seconds = Math.max(
    0,
    Math.floor(((row.endedAt ? Date.parse(row.endedAt) : now) - Date.parse(row.startedAt)) / 1000),
  );
  const command = (
    <code className={styles.commandText} title={row.command}>
      {row.command}
    </code>
  );
  const output = (
    <Button
      variant="secondary"
      className={styles.compactAction}
      disabled={busy}
      onClick={toggleOutput}
    >
      {t("background.viewOutput")}
    </Button>
  );
  const exit = row.exitCode != null ? t("background.exitCode", { code: row.exitCode }) : undefined;
  if (event)
    return (
      <div className={styles.backgroundEvent}>
        <span aria-hidden="true" className={warning ? styles.commandWarning : undefined}>
          {warning ? "!" : "✓"}
        </span>
        <span>{t("background.finished")}</span>
        <span aria-hidden="true">·</span>
        {command}
        {exit && <span className={warning ? styles.commandWarning : undefined}>· {exit}</span>}
        {row.outputLines !== undefined && (
          <span>· {t("background.lines", { lines: row.outputLines })}</span>
        )}
        {output}
      </div>
    );
  const continuation =
    row.continuation === "waiting"
      ? "background.botWaiting"
      : row.continuation === "automatic"
        ? "background.autoContinue"
        : row.continuation === "resumed"
          ? "background.continued"
          : row.continuation === "manual"
            ? "background.manualContinue"
            : undefined;
  // In the tasks pane a command is a small dark terminal card; ports are pills inside it.
  return (
    <div className={`${styles.planCard} ${styles.commandRow}`}>
      <div className={styles.commandTop}>
        <StatusDot
          state={
            warning ? "failed" : running ? "running" : row.status === "stopped" ? "stopped" : "done"
          }
        />
        {command}
        <span className={styles.commandMeta}>
          {row.outputLines !== undefined && (
            <>{t("background.lines", { lines: row.outputLines })} · </>
          )}
          {t("background.elapsed", { seconds })}
        </span>
      </div>
      <div className={styles.commandSummary}>
        <span
          className={warning ? styles.commandWarning : running ? styles.commandRunning : undefined}
        >
          {t(
            running
              ? "background.runningShort"
              : row.status === "stopped"
                ? (stoppedReason ?? "background.stoppedShort")
                : row.status === "failed"
                  ? "background.failedShort"
                  : "background.ended",
          )}
        </span>
        {exit && <span className={warning ? styles.commandWarning : undefined}>· {exit}</span>}
      </div>
      <div className={styles.commandActions}>
        {running && row.ports.length > 0 && (
          <BackgroundPortButtons
            ports={row.ports}
            className={styles.commandPorts}
            buttonClassName={`${styles.compactAction} ${styles.portPill}`}
            disabled={busy}
            onOpen={act}
            label={(port) => t("background.openPort", { port })}
          />
        )}
        <span className={styles.commandSpacer} />
        {output}
        {running && (
          <Button
            variant="secondary"
            className={`${styles.compactAction} ${styles.commandStop}`}
            disabled={busy}
            onClick={() => act("stop")}
          >
            {t(stopping ? "background.stopping" : "background.stop")}
          </Button>
        )}
        {row.continuation === "manual" && (
          <Button
            variant="secondary"
            className={`${styles.compactAction} ${styles.commandContinue}`}
            disabled={busy}
            onClick={() => act("continue")}
          >
            {t("background.continue")}
          </Button>
        )}
      </div>
      {continuation && <span className={styles.hint}>{t(continuation)}</span>}
    </div>
  );
}
