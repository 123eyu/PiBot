import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile, StatusDot } from "@pibot/ui";
import { useRef, useState } from "react";
import styles from "../computer.module.css";
import { computerErrorKey } from "../presentation.ts";
import { useComputerStates } from "../state-store.ts";

/**
 * Run-level computer notices under a reply: the foreground request (also on the indicator bar,
 * either place may answer it), waiting for the foreground, and "stopped, grant revoked".
 */
export function ComputerRunNotice({
  botId,
  runId,
  showStopped = true,
}: {
  botId: string;
  runId: string;
  /** A run has one stop: only the step group where it happened says so (maintainers 2026-11-14). */
  showStopped?: boolean;
}) {
  const t = useT();
  const { peer } = useRpc();
  const state = useComputerStates().get(botId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const locked = useRef(false);
  if (!state || state.runId !== runId) return null;
  const foreground = state.foreground;
  if (foreground?.status === "asking") {
    const answer = async (allow: boolean) => {
      if (!peer || locked.current) return;
      locked.current = true;
      setBusy(true);
      setError(undefined);
      try {
        await peer.call("computer.foreground.resolve", { requestId: foreground.requestId, allow });
      } catch (e) {
        setError(computerErrorKey(e));
      } finally {
        locked.current = false;
        setBusy(false);
      }
    };
    return (
      <section className={styles.foregroundAsk} aria-label={t("computerUse.foreground.label")}>
        <IconTile icon="hand" tone="amber" size="sm" />
        <span>
          {t("computerUse.foreground.ask", { app: foreground.app.name, action: foreground.action })}
          {error && <> · {t(error)}</>}
        </span>
        <div className={styles.foregroundActions}>
          <Button variant="secondary" disabled={busy || !peer} onClick={() => void answer(false)}>
            {t("computerUse.foreground.skip")}
          </Button>
          <Button
            className={styles.primary}
            loading={busy}
            disabled={!peer}
            onClick={() => void answer(true)}
          >
            {t("computerUse.foreground.allow")}
          </Button>
        </div>
      </section>
    );
  }
  if (foreground && foreground.status !== "running")
    return (
      <p className={styles.chatNote} role="status">
        <StatusDot state="waiting" />
        {t(`computerUse.foreground.${foreground.status}`, {
          app: foreground.app.name,
          position: foreground.queuePosition ?? 1,
        })}
      </p>
    );
  if (state.state === "paused")
    return (
      <p className={styles.chatNote} role="status">
        <StatusDot state="waiting" />
        {t(
          state.pausedBy === "activity"
            ? "computerUse.chat.pausedActivity"
            : "computerUse.state.paused",
        )}
      </p>
    );
  if (state.state === "stopped" && showStopped)
    return (
      <p className={styles.chatNote} role="status">
        <StatusDot state="stopped" />
        {t("computerUse.chat.stopped")}
      </p>
    );
  return null;
}
