import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useRpc, useSettingsDialog, useT } from "@pibot/renderer-kit";
import { Button, CloseButton, Icon, Switch } from "@pibot/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogBody } from "./LogBody.tsx";
import { useLogIndex } from "./use-index.ts";
import { logRpc, useLog } from "./use-log.ts";
import styles from "./viewer.module.css";

export interface LogDetails {
  runId: string;
  /** The step whose log to show when the run holds more than one command log. */
  toolCallId?: string;
  botId: string;
  command: string;
  exitCode: number | null;
  durationMs: number | null;
}
export function RunLogViewer({ details, close }: { details: LogDetails; close(): void }) {
  const { peer } = useRpc();
  const t = useT();
  const modal = useSettingsDialog(close);
  const titleId = useId();
  const log = useLog(peer, details.runId, details.toolCallId);
  const [name, setName] = useState(details.botId);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);
  const [columns, setColumns] = useState(100);
  const indexed = useLogIndex(log.text, query, wrap ? columns : 0);
  const { snapshot, active, jump, indexing, navigate } = indexed;
  const { index } = snapshot;
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<"failed" | "unsupported">();
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    if (peer)
      void logRpc(
        () => peer.call("bots.profile", { botId: details.botId }),
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      )
        .then((profile) => {
          if (!controller.signal.aborted) setName(profile.bot.name);
        })
        .catch(() => {
          /* Deleted Bots retain audit/log records; use their ID as a truthful fallback. */
        });
    return () => controller.abort();
  }, [peer, details.botId]);
  useEffect(() => {
    const controller = new AbortController();
    if (query)
      void log.all(controller.signal).catch(() => {
        /* The reader owns retryable errors; query replacement cancels only this wait. */
      });
    return () => controller.abort();
  }, [query, log.all]);
  const action = async (kind: "copy" | "reveal") => {
    if (actionBusy || !peer) return;
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(120_000)]);
    setActionBusy(true);
    setActionError(undefined);
    try {
      if (kind === "copy") {
        const text = await log.all(signal);
        signal.throwIfAborted();
        await logRpc(() => navigator.clipboard.writeText(text), signal);
      } else
        await logRpc(
          () =>
            peer.call("runs.revealLog", {
              runId: details.runId,
              ...(details.toolCallId ? { toolCallId: details.toolCallId } : {}),
            }),
          signal,
        );
    } catch (error) {
      if (!lifetime.current.signal.aborted)
        setActionError(
          error instanceof RpcError && error.code === RpcErrorCodes.unsupported
            ? "unsupported"
            : "failed",
        );
    } finally {
      if (!lifetime.current.signal.aborted) setActionBusy(false);
    }
  };
  const more = () => {
    if (!log.loading && !log.error && log.next !== null)
      void log.load().catch(() => {
        /* Reader exposes the retryable error. */
      });
  };
  const revealKey =
    window.pibot.platform === "darwin"
      ? "log.reveal.mac"
      : window.pibot.platform === "win32"
        ? "log.reveal.win"
        : "log.reveal.linux";
  return createPortal(
    <dialog
      ref={modal.dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        modal.close();
      }}
      onKeyDown={modal.trapFocus}
    >
      <div className={styles.header}>
        <div className={styles.heading}>
          <h2 id={titleId} className={styles.title} title={details.command}>
            {details.command.replace(/[\r\n]+/g, " ")}
          </h2>
          <CloseButton label={t("log.close")} onClick={modal.close} />
        </div>
        <div className={styles.metadata}>
          <span>{name}</span>
          {details.exitCode !== null && <span>{t("tool.exit", { code: details.exitCode })}</span>}
          {details.durationMs !== null && (
            <span>{t("tool.duration", { seconds: (details.durationMs / 1000).toFixed(1) })}</span>
          )}
        </div>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.finder}>
          <Icon name="search" size={13} />
          <input
            className={styles.search}
            type="search"
            value={query}
            aria-label={t("log.search")}
            placeholder={t("log.search")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                navigate(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className={styles.count} aria-live="polite">
            {indexing || (query && log.next !== null)
              ? t("common.loading")
              : t("log.matches", {
                  current: index.matches.length ? active + 1 : 0,
                  total: index.matches.length,
                })}
          </span>
          <Button
            variant="ghost"
            disabled={!index.matches.length || indexed.pending}
            onClick={() => navigate(-1)}
          >
            {t("log.previous")}
          </Button>
          <Button
            variant="ghost"
            disabled={!index.matches.length || indexed.pending}
            onClick={() => navigate(1)}
          >
            {t("log.next")}
          </Button>
        </div>
        <span className={styles.spacer} />
        <span className={styles.wrap}>
          {t("log.wrap")}
          <Switch label={t("log.wrap")} checked={wrap} onCheckedChange={setWrap} />
        </span>
        <Button variant="ghost" disabled={actionBusy || !peer} onClick={() => void action("copy")}>
          <Icon name="copy" size={13} />
          {t("log.copy")}
        </Button>
        <Button
          variant="ghost"
          disabled={actionBusy || !peer}
          onClick={() => void action("reveal")}
        >
          <Icon name="folder" size={13} />
          {t(revealKey)}
        </Button>
      </div>
      {log.truncated && <p className={styles.notice}>{t("log.truncated")}</p>}
      <LogBody
        label={t("log.output")}
        snapshot={snapshot}
        active={active}
        jump={jump}
        onWidth={setColumns}
        more={more}
      />
      <div className={styles.footer}>
        {log.loading && <span role="status">{t("common.loading")}</span>}
        {log.started && !log.text && !log.loading && !log.error && <span>{t("log.empty")}</span>}
        {log.error && (
          <span role="alert" className={styles.error}>
            {t(log.error === "missing" ? "log.missing" : "log.error")}{" "}
            <Button
              variant="ghost"
              onClick={() =>
                void (query ? log.all() : log.load()).catch(() => {
                  /* Reader exposes the retryable error. */
                })
              }
            >
              {t("common.retry")}
            </Button>
          </span>
        )}
        {(actionError || indexed.failed) && (
          <span role="alert" className={styles.error}>
            {t(actionError === "unsupported" ? "log.unsupported" : "log.actionError")}
          </span>
        )}
        {log.next !== null && !log.error && (
          <Button variant="ghost" disabled={log.loading} onClick={more}>
            {t("log.more")}
          </Button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
export function RunLogButton({ details, label }: { details: LogDetails; label?: string }) {
  const t = useT();
  const { peer } = useRpc();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button variant="ghost" disabled={!peer} onClick={() => setOpen(true)}>
        {label ?? t("tool.openLog")}
      </Button>
      {open && <RunLogViewer details={details} close={close} />}
    </>
  );
}
