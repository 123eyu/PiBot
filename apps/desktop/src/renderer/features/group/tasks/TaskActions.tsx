import type { ChatPeer } from "@pibot/client-core";
import { type GroupTask, type Message, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { actionError, useAction, useSettings, useT, waitRpc } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "../../chat/messages/Markdown.tsx";
import { messageClock } from "../../chat/messages/message-time-label.ts";
import { Overlay } from "../../workspace/Overlay.tsx";
import { PanelMenu } from "../../workspace/profile/PanelMenu.tsx";
import styles from "../group.module.css";

function ResolutionDialog({
  peer,
  task,
  status,
  close,
  refresh,
}: {
  peer: ChatPeer;
  task: GroupTask;
  status: "done" | "cancelled";
  close(): void;
  refresh(): Promise<void>;
}) {
  const t = useT();
  const { language } = useSettings();
  const action = useAction();
  const [summary, setSummary] = useState(
    status === "done" ? "" : t("group.cancelledSummary", { title: task.title }),
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [resultMessageId, setResultMessageId] = useState("");
  const [loading, setLoading] = useState(status === "done");
  const [readError, setReadError] = useState(false);
  useEffect(() => {
    if (status !== "done") return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
    void waitRpc(() => peer.call("chat.history", { groupId: task.groupId, limit: 50 }), signal)
      .then((rows) => {
        signal.throwIfAborted();
        const replies = rows.filter(
          (m) =>
            m.botId === task.assigneeBotId &&
            m.role === "assistant" &&
            m.status === "done" &&
            m.content.trim(),
        );
        setMessages(replies);
      })
      .catch(() => {
        if (!lifetime.signal.aborted) setReadError(true);
      })
      .finally(() => {
        if (!lifetime.signal.aborted) setLoading(false);
      });
    return () => lifetime.abort();
  }, [peer, task.groupId, task.assigneeBotId, status]);
  const submit = () =>
    void action
      .run(
        async (signal) => {
          const result = await waitRpc(
            () =>
              peer.call("groups.tasks.resolve", {
                groupId: task.groupId,
                taskId: task.id,
                status,
                summary:
                  summary.trim() ||
                  (resultMessageId ? t("group.completedSummary", { title: task.title }) : ""),
                confirmed: true,
                ...(status === "done" && resultMessageId ? { resultMessageId } : {}),
              }),
            signal,
          );
          return result;
        },
        (error) =>
          error instanceof RpcError && error.code === RpcErrorCodes.timeout
            ? "group.resolveUncertain"
            : actionError(error),
      )
      .then((result) => {
        if (result) {
          close();
          void refresh();
        }
      });
  const selected = messages.find((m) => m.id === resultMessageId);
  return (
    <Overlay
      icon={status === "done" ? "check" : "close"}
      tone={status === "done" ? "green" : "red"}
      title={t(status === "done" ? "group.markDone" : "group.cancelTask")}
      close={close}
      busy={action.busy}
    >
      <p>{t("group.resolveConfirm", { title: task.title })}</p>
      <label className={`${styles.field} ${styles.resolveField}`}>
        {t(status === "done" ? "group.resultSummary" : "group.cancelReason")}
        <textarea
          maxLength={16000}
          value={summary}
          disabled={action.busy}
          onChange={(e) => setSummary(e.target.value)}
        />
      </label>
      {status === "done" && (
        // The member's replies are option cards instead of a native select.
        <fieldset className={`${styles.field} ${styles.resultOptions}`}>
          <legend>{t("group.existingReply")}</legend>
          {[
            { id: "", label: t("group.newResult"), at: "" },
            ...messages.map((m) => ({
              id: m.id,
              label: m.content.slice(0, 120),
              at: m.createdAt,
            })),
          ].map((option) => (
            <label
              key={option.id || "none"}
              className={styles.resultOption}
              data-on={resultMessageId === option.id || undefined}
            >
              <input
                type="radio"
                name={`resolve-${task.id}`}
                value={option.id}
                checked={resultMessageId === option.id}
                disabled={action.busy || loading || readError}
                onChange={() => setResultMessageId(option.id)}
              />
              <span>
                {option.at && <b>{messageClock(new Date(option.at), language)}</b>}
                <span>{option.label}</span>
              </span>
            </label>
          ))}
          <span className={styles.note}>{t("group.resultHelp")}</span>
        </fieldset>
      )}
      {selected && (
        <section className={styles.resultPreview} aria-label={t("group.selectedReply")}>
          <Markdown text={selected.content.slice(0, 16000)} />
          {selected.content.length > 16000 && <p>{t("group.previewTruncated")}</p>}
        </section>
      )}
      {loading && <p role="status">{t("common.loading")}</p>}
      {readError && (
        <p role="alert" className={styles.error}>
          {t("chat.historyError")}
        </p>
      )}
      <div className={styles.taskActions}>
        <Button variant="secondary" disabled={action.busy} onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={action.busy}
          disabled={loading || readError || (!summary.trim() && !resultMessageId)}
          onClick={submit}
        >
          {t("group.resolveConfirmAction")}
        </Button>
      </div>
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </Overlay>
  );
}

export function TaskActions({
  peer,
  task,
  refresh,
  menu = false,
}: {
  peer: ChatPeer;
  task: GroupTask;
  refresh(): Promise<void>;
  menu?: boolean;
}) {
  const t = useT();
  const [status, setStatus] = useState<"done" | "cancelled">();
  if (task.status !== "open") return null;
  return (
    <>
      {menu ? (
        <PanelMenu
          label={t("panel.more")}
          items={[
            {
              id: "done",
              label: t("group.markDone"),
              icon: ["check", "green"],
              run: () => setStatus("done"),
            },
            {
              id: "cancel",
              label: t("group.cancelTask"),
              icon: ["close", "red"],
              danger: true,
              run: () => setStatus("cancelled"),
            },
          ]}
        />
      ) : (
        <div className={styles.taskActions}>
          <Button
            variant="ghost"
            aria-label={t("group.markDoneNamed", { title: task.title })}
            onClick={() => setStatus("done")}
          >
            {t("group.markDone")}
          </Button>
          <Button
            variant="ghost"
            aria-label={t("group.cancelTaskNamed", { title: task.title })}
            onClick={() => setStatus("cancelled")}
          >
            {t("group.cancelTask")}
          </Button>
        </div>
      )}
      {status &&
        createPortal(
          <ResolutionDialog
            key={`${task.id}:${status}`}
            peer={peer}
            task={task}
            status={status}
            close={() => setStatus(undefined)}
            refresh={refresh}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * The failed-task card in the group chat (TaskRecovery) has only a retry; a task the user no
 * longer wants stayed on screen with no way to close it there (maintainers, 2026-11-15). The same
 * cancel confirmation as the task page.
 */
export function CancelTaskButton({
  peer,
  task,
  refresh,
}: {
  peer: ChatPeer;
  task: GroupTask;
  refresh(): Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (task.status !== "open") return null;
  return (
    <>
      <Button
        variant="ghost"
        aria-label={t("group.cancelTaskNamed", { title: task.title })}
        onClick={() => setOpen(true)}
      >
        {t("group.cancelTask")}
      </Button>
      {open &&
        createPortal(
          <ResolutionDialog
            key={`${task.id}:cancelled`}
            peer={peer}
            task={task}
            status="cancelled"
            close={() => setOpen(false)}
            refresh={refresh}
          />,
          document.body,
        )}
    </>
  );
}
