import type { Message, MethodResults, TaskSummary } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, Icon, StatusDot, Switch } from "@pibot/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../chat/messages/Markdown.tsx";
import { RunReceipt } from "../receipt/RunReceipt.tsx";
import styles from "./execution.module.css";
import { RunApprovals } from "./RunApprovals.tsx";
import { TaskCheckpoint } from "./TaskCheckpoint.tsx";
import { TaskHistoryMessage } from "./TaskHistoryMessage.tsx";
import { useTaskInput } from "./task-inputs.tsx";
import { taskDot, taskTone } from "./task-look.ts";

export function TaskDetails({ task, readOnly = false }: { task: TaskSummary; readOnly?: boolean }) {
  const { peer } = useRpc();
  const t = useT();
  const [checkpoint, setCheckpoint] =
    useState<MethodResults["execution.tasks.get"]["checkpoint"]>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [verified, setVerified] = useState(false);
  const [draft, setDraft] = useState("");
  const [delivered, setDelivered] = useState(false),
    [resultOpen, setResultOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null),
    historyBox = useRef<HTMLDivElement>(null),
    anchor = useRef<{ height: number; top: number } | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: prepended history restores the scroll anchor after DOM update.
  useLayoutEffect(() => {
    const node = historyBox.current;
    if (node && anchor.current) {
      node.scrollTop = anchor.current.top + node.scrollHeight - anchor.current.height;
      anchor.current = undefined;
    }
  }, [messages]);
  const input = useTaskInput(`${task.botId}:${task.conversationId}:${task.id}`);
  const { pending } = input;
  const value = pending?.text ?? draft;
  const actionLock = useRef(false),
    loaded = useRef(false);
  const lifecycle = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keep actions alive across task version updates, cancel on scope leave.
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    actionLock.current = false;
    setSaving(false);
    loaded.current = false;
    return () => controller.abort();
  }, [peer, task.botId, task.conversationId, task.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: verification is valid for exactly the displayed task version.
  useEffect(() => setVerified(false), [task.version]);
  const scope = { botId: task.botId, conversationId: task.conversationId, taskId: task.id };
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads history; task versions never erase a draft.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const options = { signal: controller.signal, timeoutMs: 10000 };
    void Promise.all([
      peer.call(
        "execution.tasks.history",
        { botId: task.botId, conversationId: task.conversationId, taskId: task.id, limit: 25 },
        options,
      ),
      peer.call(
        "execution.tasks.get",
        { botId: task.botId, conversationId: task.conversationId, taskId: task.id },
        options,
      ),
    ])
      .then(
        ([page, detail]) => {
          if (!controller.signal.aborted) {
            setCheckpoint(detail.checkpoint);
            setMessages((current) => {
              const merged = new Map(current.map((message) => [message.id, message]));
              for (const message of page.messages) merged.set(message.id, message);
              return [...merged.values()]
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
                .slice(-100);
            });
            if (!loaded.current) {
              setNext(page.nextBefore);
              loaded.current = true;
            }
          }
        },
        () => {
          if (!controller.signal.aborted) setError(true);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [peer, task.botId, task.conversationId, task.id, task.version, refresh]);
  const act = async (operation: (signal: AbortSignal) => Promise<unknown>, reload = true) => {
    const signal = lifecycle.current?.signal;
    if (!peer || !signal || signal.aborted || actionLock.current) return;
    actionLock.current = true;
    setSaving(true);
    setError(false);
    try {
      await operation(signal);
      if (!signal.aborted && reload) setRefresh((value) => value + 1);
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      actionLock.current = false;
      if (!signal.aborted) setSaving(false);
    }
  };
  const append = () => {
    if (!peer || !value.trim() || value.length > 8000) return;
    const request = input.store.begin(input.key, value);
    if (!request) {
      setError(true);
      return;
    }
    void act(async (signal) => {
      const receipt = await peer.call(
        "execution.tasks.message",
        { ...scope, requestId: request.id, message: request.text },
        { signal, timeoutMs: 10_000 },
      );
      if (!signal.aborted) {
        if (receipt.delivery === "deferred" || receipt.delivery === "stopping") {
          input.store.deferred(input.key, request.id);
        } else {
          setDelivered(true);
          input.store.clear(input.key, request.id);
          setDraft((current) => (current === request.text ? "" : current));
        }
      }
    });
  };
  const older = () => {
    if (!peer || !next || loading || saving || messages.length >= 100) return;
    if (historyBox.current)
      anchor.current = {
        height: historyBox.current.scrollHeight,
        top: historyBox.current.scrollTop,
      };
    void act(async (signal) => {
      const page = await peer.call(
        "execution.tasks.history",
        { ...scope, before: next, limit: 25 },
        { signal, timeoutMs: 10_000 },
      );
      if (!signal.aborted) {
        setMessages((current) => {
          const ids = new Set(current.map((item) => item.id));
          return [...page.messages.filter((item) => !ids.has(item.id)), ...current].slice(-100);
        });
        setNext(page.nextBefore);
      }
    }, false);
  };
  const loadOlder = useRef(older);
  loadOlder.current = older;
  useEffect(() => {
    if (
      !historyOpen ||
      !next ||
      loading ||
      saving ||
      messages.length >= 100 ||
      !sentinel.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadOlder.current();
      },
      { root: historyBox.current },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [historyOpen, next, loading, saving, messages.length]);
  const live = !task.archivedAt && ["queued", "running", "stopping"].includes(task.status);
  return (
    <section className={`${styles.steps} ${styles.taskDetail}`} aria-label={task.title}>
      <div className={styles.detailHead}>
        <StatusDot state={taskDot(task.status)} />
        <strong>{task.title}</strong>
        <Chip tone={taskTone(task.status)}>{t(`execution.task.${task.status}`)}</Chip>
      </div>
      {checkpoint && <TaskCheckpoint checkpoint={checkpoint} />}
      {live && task.runId && (
        <RunApprovals botId={task.botId} conversationId={task.conversationId} runId={task.runId} />
      )}
      {!live && task.runId && <RunReceipt runId={task.runId} />}
      {task.result && (
        <>
          <h3>{t("agentWork.result")}</h3>
          {/* A subtask's result is its reply, written in Markdown like any chat reply. */}
          <div
            className={`${styles.output} ${styles.resultMarkdown} ${resultOpen ? "" : styles.resultPreview}`}
          >
            <Markdown text={task.result} />
          </div>
          <Button
            variant="ghost"
            className={styles.detailDisclosure}
            onClick={() => setResultOpen(!resultOpen)}
          >
            {t(resultOpen ? "agentWork.collapse" : "agentWork.expandAll")}
          </Button>
        </>
      )}
      {task.resultTruncated && <p className={styles.hint}>{t("execution.resultTruncated")}</p>}
      {live && !readOnly && (
        <>
          <h3>{t("execution.taskInput")}</h3>
          <textarea
            aria-label={t("execution.taskInput")}
            value={value}
            maxLength={8000}
            disabled={saving}
            readOnly={!!pending}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <div className={styles.detailActions}>
            <Button
              variant="primary"
              className={styles.detailSend}
              disabled={!peer || saving || !value.trim() || task.status === "stopping"}
              onClick={append}
            >
              {t(pending ? "execution.retryInput" : "execution.append")}
            </Button>
            <Button
              variant="secondary"
              className={styles.detailStop}
              disabled={!peer || saving || task.status === "stopping"}
              onClick={() =>
                void act((signal) =>
                  peer
                    ? peer.call("execution.tasks.cancel", scope, { signal, timeoutMs: 10_000 })
                    : Promise.resolve(),
                )
              }
            >
              {t("execution.stopTask")}
            </Button>
          </div>
          {task.status === "stopping" && (
            <p className={styles.hint}>{t("execution.stoppingHint")}</p>
          )}
        </>
      )}
      {delivered && !pending && (
        <p role="status" className={styles.hint}>
          {t("agentWork.delivered")}
        </p>
      )}
      {pending && (
        <div role="status" className={styles.hint}>
          {t(pending.state === "deferred" ? "execution.inputDeferred" : "execution.inputUncertain")}
          {!live && <pre className={styles.output}>{pending.text}</pre>}
        </div>
      )}
      {task.status === "interrupted" && !task.archivedAt && !readOnly && (
        <>
          <p className={`${styles.planHint} ${styles.detailWarn}`}>
            <Icon name="warning" size={14} />
            <span>{t("agentWork.interrupted")}</span>
          </p>
          {task.needsVerification && (
            <Switch
              label={t("execution.verifySideEffects")}
              checked={verified}
              onCheckedChange={setVerified}
            />
          )}
          <Button
            variant="primary"
            className={styles.detailSend}
            disabled={!peer || !task.runId || saving || (task.needsVerification && !verified)}
            onClick={() =>
              void act((signal) =>
                peer && task.runId
                  ? peer.call(
                      "runs.retry",
                      {
                        source: "subtask",
                        botId: scope.botId,
                        conversationId: scope.conversationId,
                        taskId: scope.taskId,
                        failedRunId: task.runId,
                        expectedVersion: task.version,
                        verifiedSideEffects: verified,
                      },
                      { signal, timeoutMs: 20_000 },
                    )
                  : Promise.resolve(),
              )
            }
          >
            {t("execution.resumeTask")}
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        className={styles.detailDisclosure}
        aria-expanded={historyOpen}
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        <Icon
          name="chevronRight"
          size={14}
          style={{ transform: historyOpen ? "rotate(90deg)" : undefined }}
        />
        {t("execution.taskHistory")}
      </Button>
      {error && (
        <p role="alert" className={styles.error}>
          {t("execution.loadError")}{" "}
          <Button
            variant="ghost"
            disabled={loading || saving}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t("common.retry")}
          </Button>
        </p>
      )}
      {loading && <p role="status">{t("common.loading")}</p>}
      {!loading && !messages.length && <p className={styles.hint}>{t("execution.noHistory")}</p>}
      {historyOpen && (
        <div ref={historyBox} className={styles.historyScroll}>
          <div ref={sentinel} />
          {messages.map((message) => (
            <TaskHistoryMessage key={message.id} message={message} botId={task.botId} />
          ))}
        </div>
      )}
    </section>
  );
}
