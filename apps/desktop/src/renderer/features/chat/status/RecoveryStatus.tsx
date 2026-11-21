import type { Bot, ChatRecovery, Message } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useChangesLink } from "@pibot/workspaces/ui";
import { useEffect, useState } from "react";
import styles from "../chat.module.css";

/** Metadata only. Opening this view never continues a run or restores files. */
export function RecoveryStatus({
  message,
  bot,
  checked,
  close,
  busy,
}: {
  message: Message;
  bot: Bot;
  checked(ready: boolean): void;
  close(): void;
  busy: boolean;
}) {
  const t = useT(),
    { peer } = useRpc(),
    changes = useChangesLink();
  const [value, setValue] = useState<ChatRecovery>();
  const [error, setError] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    void revision;
    const lifetime = new AbortController();
    checked(false);
    setValue(undefined);
    setError(false);
    if (!peer || !message.runId) return () => lifetime.abort();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]);
    void peer
      .call(
        "chat.recovery",
        {
          botId: bot.id,
          conversationId: message.conversationId,
          runId: message.runId,
        },
        { signal, timeoutMs: 20_000 },
      )
      .then((result) => {
        if (lifetime.signal.aborted) return;
        setValue(result);
        checked(result.continuation === "ready" || result.continuation === "already_requested");
      })
      .catch(() => {
        if (!lifetime.signal.aborted) setError(true);
      });
    return () => lifetime.abort();
  }, [peer, bot.id, message.conversationId, message.runId, checked, revision]);
  return (
    <section aria-label={t("recovery.title")}>
      <p className={styles.notice}>{t("recovery.help")}</p>
      {!value && !error && <p role="status">{t("common.loading")}</p>}
      {error && <p role="alert">{t("recovery.readFailed")}</p>}
      {value && (
        <>
          <p>
            {t("recovery.run")}: {t(`recovery.run.${value.run.status}`)}
          </p>
          {value.task && (
            <p>
              {t("recovery.task")}: {value.task.title} · {t(`group.status.${value.task.status}`)}
            </p>
          )}
          <p>
            {t("recovery.session")}: {t(`recovery.session.${value.session.state}`)}
          </p>
          {value.session.state === "available" && (
            <>
              <p className={styles.notice}>
                {t("recovery.entries", { count: value.session.entryCount })}
              </p>
              <p>
                {value.session.checkpoint
                  ? t("recovery.checkpoint", {
                      time: new Date(value.session.checkpoint.createdAt).toLocaleString(),
                      tokens: value.session.checkpoint.tokensBefore,
                    })
                  : t("recovery.noCheckpoint")}
              </p>
            </>
          )}
          <p className={styles.notice}>{t(`recovery.continuation.${value.continuation}`)}</p>
          <p className={styles.notice}>
            {t(
              value.fileCheckpoint?.state === "retained"
                ? "recovery.filesRetained"
                : "recovery.filesUnavailable",
            )}
          </p>
          {changes && message.runId && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                changes.open({ scope: "turn", runId: message.runId as string });
                close();
              }}
            >
              {t("recovery.openFiles")}
            </Button>
          )}
        </>
      )}
      <Button variant="ghost" disabled={busy} onClick={() => setRevision((prior) => prior + 1)}>
        {t("recovery.refresh")}
      </Button>
    </section>
  );
}
