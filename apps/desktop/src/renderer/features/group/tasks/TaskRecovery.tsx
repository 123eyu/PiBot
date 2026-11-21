import type { ChatPeer } from "@pibot/client-core";
import { type Bot, type GroupTask, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { saveBotModel } from "../../chat/status/ModelRecovery.tsx";
import { BudgetRaise } from "../../receipt/RunReceipt.tsx";
import { useRunReceipt } from "../../receipt/receipt-store.ts";
import { Overlay } from "../../workspace/Overlay.tsx";
import { useCatalog } from "../../workspace/profile/catalog.ts";
import { ModelFields, normalizedThinking } from "../../workspace/profile/ModelFields.tsx";
import styles from "../group.module.css";
import { CancelTaskButton } from "./TaskActions.tsx";

function AgentRetry({
  peer,
  task,
  bot,
  runId,
  refresh,
}: {
  peer: ChatPeer;
  task: GroupTask;
  bot: Bot;
  runId: string;
  refresh(): Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void peer
          .call(
            "runs.retry",
            {
              source: "group",
              botId: bot.id,
              conversationId: task.threadConversationId,
              groupId: task.groupId,
              taskId: task.id,
              failedRunId: runId,
            },
            { timeoutMs: 30_000 },
          )
          .then(refresh, () => refresh())
          .finally(() => setBusy(false));
      }}
    >
      {t("common.retry")}
    </Button>
  );
}

export function TaskRecovery({
  peer,
  task,
  bot,
  refresh,
  cancellable = false,
}: {
  peer: ChatPeer;
  task: GroupTask;
  bot?: Bot;
  refresh(): Promise<void>;
  /** Off where the task's own actions are already shown (the task page). */
  cancellable?: boolean;
}) {
  const t = useT();
  const [dialog, setDialog] = useState(false);
  const { peer: receiptPeer } = useRpc();
  const failure = task.status === "open" ? task.activity?.failure : undefined;
  const receipt = useRunReceipt(
    receiptPeer,
    failure?.code === "budget_exhausted" ? failure.runId : undefined,
  );
  if (!failure) return null;
  return (
    <section className={styles.taskFailure} role="alert" aria-label={t("group.taskFailed")}>
      <strong>
        <Icon name="warning" size={15} />
        {t("group.failedNamed", { name: bot?.name ?? t("group.member") })}
      </strong>
      <span className={styles.taskFailureTitle}>{task.title}</span>
      <p>{t(`errors.${failure.code}`)}</p>
      {receipt.data?.budgetRaise && (
        <BudgetRaise
          receipt={receipt.data}
          reload={() => {
            receipt.retry();
            void refresh();
          }}
        />
      )}
      <div className={styles.taskActions}>
        {bot?.kind === "agent" ? (
          // An external agent has no Pi Bot model to pick: retry it as it is.
          <AgentRetry peer={peer} task={task} bot={bot} runId={failure.runId} refresh={refresh} />
        ) : (
          <Button variant="secondary" disabled={!bot} onClick={() => setDialog(true)}>
            {t("group.recoverTask")}
          </Button>
        )}
        {cancellable && <CancelTaskButton peer={peer} task={task} refresh={refresh} />}
      </div>
      {dialog &&
        bot &&
        createPortal(
          <RecoveryDialog
            key={failure.runId}
            peer={peer}
            task={task}
            bot={bot}
            close={() => setDialog(false)}
            refresh={refresh}
          />,
          document.body,
        )}
    </section>
  );
}

function RecoveryDialog({
  peer,
  task,
  bot,
  close,
  refresh,
}: {
  peer: ChatPeer;
  task: GroupTask;
  bot: Bot;
  close(): void;
  refresh(): Promise<void>;
}) {
  const t = useT(),
    catalog = useCatalog();
  const [model, setModel] = useState(JSON.stringify([bot.modelProvider, bot.modelId]));
  const [thinking, setThinking] = useState<Bot["thinkingLevel"] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(false);
  const locked = useRef(false),
    lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  const selected = catalog.models.find((m) => JSON.stringify([m.provider, m.id]) === model);
  const submit = async () => {
    const failure = task.activity?.failure;
    if (!selected || !failure || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(30_000)]);
    const thinkingLevel = normalizedThinking(
      selected,
      thinking ??
        (bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference),
    );
    try {
      await saveBotModel(peer, bot, selected, thinkingLevel);
      await peer.call(
        "runs.retry",
        {
          source: "group",
          botId: task.assigneeBotId,
          conversationId: task.threadConversationId,
          groupId: task.groupId,
          taskId: task.id,
          failedRunId: failure.runId,
          model: { provider: selected.provider, id: selected.id },
          thinkingLevel,
        },
        { signal, timeoutMs: 30_000 },
      );
      if (!lifetime.current.signal.aborted) {
        close();
        await refresh();
      }
    } catch (cause) {
      if (!lifetime.current.signal.aborted) {
        setUncertain(
          signal.aborted || (cause instanceof RpcError && cause.code === RpcErrorCodes.timeout),
        );
        setError(true);
        void refresh();
      }
    } finally {
      locked.current = false;
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  return (
    <Overlay icon="refresh" tone="orange" title={t("group.recoverTask")} close={close} busy={busy}>
      <p>{task.title}</p>
      <p className={styles.note}>{t("group.recoverHelp")}</p>
      <ModelFields
        models={catalog.models}
        providers={catalog.providers}
        value={model}
        thinking={normalizedThinking(
          selected ?? { reasoning: false },
          thinking ??
            (bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference),
        )}
        disabled={busy || uncertain || catalog.loading}
        change={(value, next) => {
          setModel(value);
          if (next !== undefined) setThinking(next);
        }}
      />
      {catalog.loading && <p role="status">{t("common.loading")}</p>}
      {catalog.error && (
        <p role="alert" className={styles.error}>
          {t("group.recoverModelsError")}{" "}
          <Button variant="ghost" onClick={catalog.reload}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(uncertain ? "group.recoverUncertain" : "group.recoverFailed")}
        </p>
      )}
      <div className={styles.taskActions}>
        <Button variant="secondary" disabled={busy} onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button
          disabled={busy || catalog.loading || catalog.error || !selected}
          loading={busy}
          onClick={() => void submit()}
        >
          {t(uncertain ? "group.recoverCheck" : "group.recoverStart")}
        </Button>
      </div>
    </Overlay>
  );
}
