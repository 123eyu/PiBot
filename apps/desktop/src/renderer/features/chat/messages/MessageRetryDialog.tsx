import type { Message, MethodResults } from "@pibot/protocol";
import { useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { Button, CloseButton, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./message-actions.module.css";

export function MessageRetryDialog({
  message,
  botId,
  close,
}: {
  message: Message;
  botId: string;
  close(): void;
}) {
  const { peer } = useRpc(),
    { navigate } = useNavigation(),
    t = useT();
  const dialog = useRef<HTMLDialogElement>(null),
    lifetime = useRef<AbortController | undefined>(undefined);
  const request = useRef(crypto.randomUUID());
  const [preview, setPreview] = useState<MethodResults["chat.retryPreview"]>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [submitted, setSubmitted] = useState(false);
  const source = { botId, conversationId: message.conversationId, messageId: message.id };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const element = dialog.current;
    element?.showModal();
    if (peer)
      void peer
        .call(
          "chat.retryPreview",
          { botId, conversationId: message.conversationId, messageId: message.id },
          { signal: controller.signal, timeoutMs: 30000 },
        )
        .then(
          (value) => {
            if (!controller.signal.aborted) setPreview(value);
          },
          () => {
            if (!controller.signal.aborted) setError(true);
          },
        );
    return () => {
      controller.abort();
      element?.close();
    };
  }, [peer, botId, message.conversationId, message.id]);
  const accept = (receipt: MethodResults["chat.retryFromMessage"] | null) => {
    if (receipt?.state === "done" && receipt.conversationId) {
      navigate({ name: "chat", botId, topicId: receipt.conversationId });
      close();
    } else if (receipt?.state === "failed") setError(true);
  };
  const submit = async () => {
    const signal = lifetime.current?.signal;
    if (!peer || !signal || signal.aborted || !preview || busy) return;
    setBusy(true);
    setError(false);
    try {
      const value = submitted
        ? await peer.call(
            "chat.retryStatus",
            { ...source, requestId: request.current },
            { signal, timeoutMs: 10000 },
          )
        : await peer.call(
            "chat.retryFromMessage",
            { ...source, requestId: request.current, hash: preview.hash, confirmed: true },
            { signal, timeoutMs: 185000 },
          );
      if (!signal.aborted) {
        setSubmitted(true);
        accept(value);
      }
    } catch {
      if (!signal.aborted) {
        setSubmitted(true);
        setError(true);
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="message-retry-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <h2 id="message-retry-title">
          <IconTile icon="refresh" tone="blue" size="lg" />
          {t("messages.retry")}
        </h2>
        <CloseButton label={t("messages.close")} disabled={busy} onClick={close} />
      </header>
      <div className={styles.dialogBody}>
        <p>{t("messages.retryHint")}</p>
        {preview ? (
          <p className={styles.preview}>
            {t(preview.restoreFiles ? "messages.retryFiles" : "messages.retryNoFiles", {
              count: preview.fileCount,
            })}
          </p>
        ) : (
          <p role="status">{t(error ? "messages.retryUnavailable" : "common.loading")}</p>
        )}
        <p>{t("messages.retryExternal")}</p>
        {submitted && (
          <p role="status" className={styles.banner} data-tone="ok">
            {t("messages.retrySubmitted")}
          </p>
        )}
        {error && preview && (
          <p role="alert" className={styles.banner} data-tone="danger">
            {t("messages.retryFailed")}
          </p>
        )}
      </div>
      <footer>
        <Button variant="ghost" disabled={busy} onClick={close}>
          {t("messages.close")}
        </Button>
        <Button disabled={busy || !preview} onClick={() => void submit()}>
          {t(submitted ? "messages.checkStatus" : busy ? "common.loading" : "messages.retry")}
        </Button>
      </footer>
    </dialog>
  );
}
