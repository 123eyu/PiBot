import type { ChatPeer } from "@pibot/client-core";
import { type GroupTask, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../group.module.css";

export function TaskSupplement({
  peer,
  task,
  refresh,
}: {
  peer: ChatPeer;
  task: GroupTask;
  refresh(): Promise<void>;
}) {
  const t = useT(),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<"failed" | "uncertain">(),
    [sent, setSent] = useState(false);
  const lock = useRef(false),
    lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  const send = async () => {
    if (lock.current || !draft.trim() || error === "uncertain") return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setSent(false);
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(35000)]),
      text = draft;
    try {
      await peer.call(
        "chat.send",
        {
          groupId: task.groupId,
          threadId: task.threadConversationId,
          topicId: task.threadConversationId,
          text,
        },
        { signal, timeoutMs: 35000 },
      );
      if (!signal.aborted) {
        setDraft((current) => (current === text ? "" : current));
        setSent(true);
        await refresh();
      }
    } catch (cause) {
      if (!lifetime.current.signal.aborted)
        setError(
          signal.aborted || (cause instanceof RpcError && cause.code === RpcErrorCodes.timeout)
            ? "uncertain"
            : "failed",
        );
    } finally {
      lock.current = false;
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  return (
    // Adding instructions is a soft fold card; the field opens under its title.
    <details className={`${styles.taskFold} ${styles.taskSupplement}`}>
      <summary>{t("group.taskSupplement")}</summary>
      <label className={`${styles.field} ${styles.resolveField}`}>
        <span className={styles.visuallyHidden}>{t("group.taskSupplement")}</span>
        <textarea
          value={draft}
          maxLength={8000}
          disabled={busy || error === "uncertain"}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <Button
        variant="secondary"
        disabled={busy || !draft.trim() || error === "uncertain"}
        loading={busy}
        onClick={() => void send()}
      >
        {t("execution.append")}
      </Button>
      {sent && (
        <p role="status" className={styles.note}>
          {t("agentWork.delivered")}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error === "uncertain" ? "group.uncertain" : "group.taskSupplementFailed")}
        </p>
      )}
    </details>
  );
}
