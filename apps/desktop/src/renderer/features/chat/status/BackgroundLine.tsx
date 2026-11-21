import type { TranslationKey } from "@pibot/i18n";
import { type BackgroundCommand, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { approvalStyles as styles, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { BackgroundCommandCompact } from "../../execution/BackgroundCommandCompact.tsx";
import { BackgroundPortButtons } from "../../execution/BackgroundPortButtons.tsx";
import { stoppedReasonKey } from "../../execution/background-reason.ts";
import { requestBrowserPane } from "../../side-pane/browser-requests.ts";
import { ToolOutput } from "../tools/ToolOutput.tsx";
import { acceptBackgroundCommand, useBackgroundCommand } from "./background-commands.ts";

/**
 * Under a run_command step that started a background command — "Running in background ·
 * command · Port 8010 · Open in Bot browser · Stop" while it runs, the outcome once it ended.
 * Both buttons go through RPC; brain opens only loopback ports the command really listens on,
 * in the Bot's own browser.
 */
export function BackgroundLine({
  botId,
  runId,
  toolCallId,
  runningOnly = false,
}: {
  botId: string;
  runId: string;
  toolCallId: string;
  /** Under a folded step group: show the line only while the command runs. */
  runningOnly?: boolean;
}) {
  const { peer } = useRpc();
  const row = useBackgroundCommand(peer, botId, runId, toolCallId, true);
  if (!row || (runningOnly && row.status !== "running")) return null;
  return <BackgroundCommandLine row={row} />;
}

export function BackgroundCommandLine({
  row,
  presentation = "tool",
}: {
  row: BackgroundCommand;
  presentation?: "tool" | "task" | "event";
}) {
  const t = useT();
  const { peer } = useRpc();
  const botId = row.botId;
  const [busy, setBusy] = useState<"stop" | "continue" | "output" | number | undefined>();
  const [output, setOutput] = useState<string>();
  const [error, setError] = useState<TranslationKey>();
  const [now, setNow] = useState(Date.now());
  const running = row?.status === "running";
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const actionRead = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing the peer or command retires its pending action and output.
  useEffect(() => {
    mounted.current = true;
    setBusy(undefined);
    setOutput(undefined);
    setError(undefined);
    return () => {
      mounted.current = false;
      actionRead.current?.abort();
    };
  }, [peer, row.id]);
  const act = async (action: "stop" | "continue" | "output" | number) => {
    if (!peer || busy !== undefined || actionRead.current) return;
    const controller = new AbortController();
    actionRead.current = controller;
    const options = { signal: controller.signal, timeoutMs: 20_000 };
    setBusy(action);
    setError(undefined);
    try {
      if (action === "stop" || action === "continue") {
        const current = await peer.call(
          action === "stop" ? "backgroundCommands.stop" : "backgroundCommands.continue",
          { botId, id: row.id },
          options,
        );
        if (mounted.current && !controller.signal.aborted) acceptBackgroundCommand(peer, current);
      } else if (action === "output") {
        const result = await peer.call("backgroundCommands.output", { botId, id: row.id }, options);
        if (mounted.current && !controller.signal.aborted)
          setOutput(result.text ?? t("tool.noOutput"));
      } else {
        // A new tab in this Bot's own browser; the side pane switches to it.
        await peer.call("backgroundCommands.open", { botId, id: row.id, port: action }, options);
        if (!mounted.current || controller.signal.aborted) return;
        requestBrowserPane(botId, row.groupId ?? undefined);
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted)
        setError(
          cause instanceof RpcError && cause.message === "background_topic_busy"
            ? "background.topicBusy"
            : cause instanceof RpcError && cause.message === "background_continuation_unavailable"
              ? "background.continuationUnavailable"
              : cause instanceof RpcError && cause.code === RpcErrorCodes.timeout
                ? "background.actionTimeout"
                : "background.actionError",
        );
    } finally {
      if (mounted.current && !controller.signal.aborted) setBusy(undefined);
      if (actionRead.current === controller) actionRead.current = undefined;
    }
  };
  const stoppedReason = stoppedReasonKey(row);
  const label =
    row.status === "running"
      ? t(row.promoted ? "background.promoted" : "background.running")
      : row.status === "exited"
        ? t("background.exited", { code: row.exitCode ?? "?" })
        : row.status === "failed"
          ? t("background.commandFailed")
          : // Say why it stopped (e.g. listened beyond 127.0.0.1) instead of only "stopped".
            stoppedReason
            ? t(stoppedReason)
            : t("background.stopped");
  if (presentation !== "tool")
    return (
      <>
        <BackgroundCommandCompact
          row={row}
          event={presentation === "event"}
          now={now}
          busy={!peer || busy !== undefined}
          stopping={busy === "stop"}
          act={(action) => void act(action)}
          toggleOutput={() => (output === undefined ? void act("output") : setOutput(undefined))}
        />
        {error && (
          <span role="alert" className={styles.risk}>
            {t(error)}
          </span>
        )}
        {output !== undefined && <ToolOutput output={output} expanded={true} />}
      </>
    );
  return (
    <>
      <div className={styles.background} role="status" data-running={running}>
        {running && <span className={styles.backgroundDot} aria-hidden="true" />}
        <span className={styles.backgroundLabel}>{label}</span>
        <span className={styles.backgroundMuted} aria-live="off">
          {t(row.outputLines === undefined ? "background.elapsed" : "background.progress", {
            lines: row.outputLines ?? 0,
            seconds: Math.max(
              0,
              Math.floor(
                ((row.endedAt ? Date.parse(row.endedAt) : now) - Date.parse(row.startedAt)) / 1000,
              ),
            ),
          })}
        </span>
        <code className={styles.backgroundCommand} title={row.command}>
          {row.command}
        </code>
        <span className={styles.backgroundMuted}>
          {t(
            row.continuation === "waiting"
              ? "background.botWaiting"
              : row.continuation === "automatic"
                ? "background.autoContinue"
                : row.continuation === "resumed"
                  ? "background.continued"
                  : row.status === "running"
                    ? "background.manualContinue"
                    : "background.ended",
          )}
        </span>
        {running &&
          !row.promoted &&
          (row.ports.length ? (
            <BackgroundPortButtons
              ports={row.ports}
              variant="ghost"
              className={styles.backgroundPorts}
              buttonClassName={styles.backgroundButton}
              disabled={!peer || busy !== undefined}
              onOpen={(port) => void act(port)}
              label={(port) => t("background.openPort", { port })}
            />
          ) : (
            <span className={styles.backgroundMuted}>
              {t(row.portsVisible ? "background.waitingPort" : "background.portHidden")}
            </span>
          ))}
        {row.continuation === "manual" && (
          <Button
            variant="secondary"
            disabled={busy !== undefined || !peer}
            onClick={() => void act("continue")}
          >
            {t("background.continue")}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy !== undefined || !peer}
          onClick={() => (output === undefined ? void act("output") : setOutput(undefined))}
        >
          {t("background.viewOutput")}
        </Button>
        {running && (
          <Button
            variant="secondary"
            className={styles.backgroundButton}
            disabled={!peer || busy !== undefined}
            onClick={() => void act("stop")}
          >
            {busy === "stop" ? t("background.stopping") : t("background.stop")}
          </Button>
        )}
        {error && (
          <span role="alert" className={styles.risk}>
            {t(error)}
          </span>
        )}
      </div>
      {output !== undefined && <ToolOutput output={output} expanded={true} />}
    </>
  );
}
