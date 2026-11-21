import { interruptedMessage } from "@pibot/client-core";
import { type Message, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { requirePeer } from "../../settings/operations.ts";
import styles from "../chat.module.css";

/** Explicit user continuation of a run that the previous process interrupted. */
export function InterruptedRecovery({ message, botId }: { message: Message; botId?: string }) {
  const t = useT(),
    { peer } = useRpc();
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<"failed" | "uncertain">();
  const locked = useRef(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  if (!interruptedMessage(message)) return null;

  const resume = async () => {
    if (!botId || !message.runId || locked.current || requested || error === "uncertain") return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(30_000)]);
    try {
      await requirePeer(peer).call(
        "runs.resume",
        {
          botId,
          conversationId: message.conversationId,
          runId: message.runId,
          origin: "user",
        },
        { signal, timeoutMs: 30_000 },
      );
      if (!lifetime.current.signal.aborted) setRequested(true);
    } catch (cause) {
      if (!lifetime.current.signal.aborted)
        setError(
          signal.aborted || (cause instanceof RpcError && cause.code === RpcErrorCodes.timeout)
            ? "uncertain"
            : "failed",
        );
    } finally {
      locked.current = false;
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };

  return (
    <div>
      <div className={`${styles.actions} ${styles.band}`} data-tone="warn">
        <span className={styles.notice} role="status">
          {t("chat.interrupted")}
        </span>
        <Button
          variant="ghost"
          loading={busy}
          disabled={!peer || !botId || !message.runId || requested || error === "uncertain"}
          onClick={() => void resume()}
        >
          {t(requested ? "chat.resuming" : "common.continue")}
        </Button>
      </div>
      {error && (
        <p className={`${styles.notice} ${styles.band}`} data-tone="danger" role="alert">
          {t(error === "uncertain" ? "chat.resumeUncertain" : "chat.resumeFailed")}
        </p>
      )}
    </div>
  );
}
