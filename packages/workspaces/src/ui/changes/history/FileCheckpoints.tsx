import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import type {
  ChangesTarget,
  CheckpointCapture,
  FileCheckpoint,
  FileRestore,
} from "@pibot/workspaces-contract/full";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { WorkspacePopupMenu as PopupMenu } from "../../shell/ports.tsx";
import type { ManagedResourcesApi } from "../worktrees/managed-resource-api.ts";
import styles from "../worktrees/managed-resources.module.css";
import {
  checkpointNotice,
  mergeRestoreReceipts,
  restoreSettled,
} from "./checkpoint-presentation.ts";
import { CheckpointRoots } from "./checkpoint-roots.tsx";
import { RestoreHistory, RestoreResults } from "./RestoreHistory.tsx";
import { useRestoreRequest } from "./restore-requests.tsx";

type Selection = {
  selected: ReadonlySet<string>;
  capable(path: string): boolean;
  reason(path: string): string | undefined;
  toggle(path: string, selected: boolean): void;
  disabled: boolean;
  allRestored: boolean;
};
const CheckpointSelection = createContext<Selection | null>(null);
export const useCheckpointSelection = () => useContext(CheckpointSelection);

/** Legacy turns without a capture receipt stay view-only. */
export function FileCheckpoints(props: Parameters<typeof RootFileCheckpoints>[0]) {
  return (
    <CheckpointRoots
      api={props.api}
      target={props.target}
      runId={props.runId}
      capture={props.capture}
    >
      {(root) => (
        <RootFileCheckpoints
          {...props}
          key={root?.id ?? "unavailable"}
          target={root ? { ...props.target, rootId: root.rootId } : props.target}
          capture={
            root
              ? { state: "retained", checkpointId: root.id, reason: null }
              : props.capture?.state === "retained"
                ? undefined
                : props.capture
          }
        />
      )}
    </CheckpointRoots>
  );
}
function RootFileCheckpoints({
  api,
  target,
  runId,
  botId,
  capture,
  pending,
  hasFiles,
  paths,
  restoredCount,
  running,
  children,
}: {
  api: ManagedResourcesApi;
  target: ChangesTarget;
  runId?: string;
  botId?: string | null;
  capture?: CheckpointCapture;
  pending: boolean;
  hasFiles: boolean;
  paths: readonly string[];
  restoredCount: number;
  running: boolean;
  children: ReactNode;
}) {
  const t = useT(),
    { peer } = useRpc();
  const checkpointId = capture?.state === "retained" ? capture.checkpointId : undefined;
  const scopeKey = JSON.stringify(target),
    key = JSON.stringify([target, runId, checkpointId]);
  const request = useRestoreRequest(key);
  const [checkpoint, setCheckpoint] = useState<FileCheckpoint>(),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [receipts, setReceipts] = useState<FileRestore[]>([]),
    [restore, setRestore] = useState<FileRestore>(),
    [busy, setBusy] = useState(!!checkpointId),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(false),
    [revision, setRevision] = useState(0),
    [confirm, setConfirm] = useState(false),
    [history, setHistory] = useState(false),
    [nextHistory, setNextHistory] = useState<string | null>(null);
  const actionLock = useRef(false),
    lifetime = useRef<AbortController | undefined>(undefined);
  const accept = (value: FileRestore) => {
    setRestore((prior) =>
      prior?.id === value.id && prior.updatedAt > value.updatedAt ? prior : value,
    );
    setReceipts((items) => mergeRestoreReceipts(items, [value]));
    setConfirm(false);
    if (restoreSettled(value)) {
      request.store.clear(key, value.id);
      setSelected(new Set());
    }
    if (value.state !== "done") setHistory(true);
  };
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  useEffect(() => {
    if (!peer) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = peer.on("changes.changed", (event) => {
      if (event.runId && event.runId !== runId) return;
      if (event.conversationKey && event.conversationKey !== target.conversationKey) return;
      if (event.topicId && event.topicId !== target.topicId) return;
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 250);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [peer, runId, target.conversationKey, target.topicId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a canonical scope owns each mutation; metadata events do not cancel it.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    actionLock.current = false;
    setSaving(false);
    return () => controller.abort();
  }, [api, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: canonical target and receipt ID avoid object-identity reloads; revision retries known records only.
  useEffect(() => {
    if (!checkpointId || !runId) {
      setBusy(false);
      setCheckpoint(undefined);
      setReceipts([]);
      setError(false);
      return;
    }
    const controller = new AbortController(),
      options = { signal: controller.signal, timeoutMs: 15000 };
    const scoped = JSON.parse(scopeKey) as ChangesTarget;
    setBusy(true);
    setError(false);
    void Promise.all([
      api.call("changes.checkpoints.get", { target: scoped, id: checkpointId }, options),
      api.call(
        "changes.checkpoints.restores",
        { target: scoped, id: checkpointId, limit: 20 },
        options,
      ),
    ])
      .then(([value, operations]) => {
        if (controller.signal.aborted) return;
        if (value.id !== checkpointId || value.runId !== runId || (botId && value.botId !== botId))
          throw Error("checkpoint_scope_mismatch");
        if (operations.items.some((item) => item.checkpointId !== checkpointId))
          throw Error("checkpoint_scope_mismatch");
        setCheckpoint(value);
        setReceipts((items) => mergeRestoreReceipts(items, operations.items));
        setNextHistory(operations.nextBefore);
        const original = request.store.get(key);
        if (original) {
          const requested = new Set(original.itemIds);
          setSelected(
            new Set(value.items.filter((item) => requested.has(item.id)).map((item) => item.path)),
          );
          const receipt = operations.items.find((item) => item.id === original.requestId);
          if (receipt) acceptRef.current(receipt);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [api, scopeKey, key, checkpointId, runId, botId, revision, request.store]);
  const value =
    checkpoint && checkpoint.id === checkpointId && checkpoint.runId === runId
      ? checkpoint
      : undefined;
  const act = async (operation: (signal: AbortSignal) => Promise<FileRestore>) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busy || actionLock.current) return;
    actionLock.current = true;
    setSaving(true);
    setError(false);
    try {
      const receipt = await operation(signal);
      if (!signal.aborted) {
        if (receipt.checkpointId !== checkpointId) throw Error("checkpoint_scope_mismatch");
        acceptRef.current(receipt);
      }
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (lifetime.current?.signal === signal) {
        actionLock.current = false;
        if (!signal.aborted) setSaving(false);
      }
    }
  };
  const byPath = new Map(value?.items.map((item) => [item.path, item]) ?? []);
  const currentPaths = new Set(paths);
  const restoredIds = new Set(
    receipts.flatMap((receipt) =>
      receipt.items.filter((item) => item.state === "restored").map((item) => item.itemId),
    ),
  );
  const capable = (path: string) => {
    const item = byPath.get(path);
    return (
      value?.state !== "expired" &&
      currentPaths.has(path) &&
      item?.restorable === true &&
      !restoredIds.has(item.id)
    );
  };
  const selectedPaths = new Set([...selected].filter(capable));
  const hasRestorableFiles = paths.some(capable);
  const restoreSelected = () => {
    if (!value) return;
    const itemIds = [...selectedPaths].flatMap((path) => {
      const item = byPath.get(path);
      return item?.restorable ? [item.id] : [];
    });
    void act((signal) => {
      // Record uncertainty only once this pane actually owns the in-flight mutation.
      const original =
        request.pending ??
        (itemIds.length
          ? request.store.begin(key, { id: value.id, expectedVersion: value.version, itemIds })
          : undefined);
      if (!original) throw Error("restore_request_unavailable");
      return api.call(
        "changes.checkpoints.restore",
        { target, ...original },
        { signal, timeoutMs: 120000 },
      );
    });
  };
  const selection: Selection = {
    selected: selectedPaths,
    disabled: busy || saving || running || !!request.pending,
    capable,
    allRestored: !hasFiles && restoredCount > 0,
    reason: (path) => {
      const item = byPath.get(path);
      return item?.reason
        ? t(`checkpoint.itemReason.${item.reason}`)
        : item
          ? undefined
          : value &&
              !path.startsWith(`${value.root.replace(/[\\/]+$/, "")}/`) &&
              !path.startsWith(`${value.root.replace(/[\\/]+$/, "")}\\`)
            ? t("checkpoint.otherRoot")
            : t("checkpoint.itemReason.snapshot_missing");
    },
    toggle: (path, checked) => {
      if (request.pending) return;
      setSelected((prior) => {
        const next = new Set(prior);
        if (checked) next.add(path);
        else next.delete(path);
        return next;
      });
      setConfirm(false);
    },
  };
  const notice = checkpointNotice(capture, pending, hasFiles);
  return (
    <CheckpointSelection.Provider value={selection}>
      {children}
      <div className={styles.section}>
        <p className={styles.hint}>{t("checkpoint.coverage")}</p>
        {notice && (
          <p className={capture?.state === "skipped" ? styles.conflict : styles.hint} role="status">
            {t(notice)}
          </p>
        )}
        {busy && <p role="status">{t("common.loading")}</p>}
        {value &&
          (value.state !== "available" ||
            value.truncated ||
            !value.items.some((item) => item.restorable)) && (
            <p className={styles.hint}>
              {t(
                value.state === "expired"
                  ? "checkpoint.expired"
                  : value.items.some((item) => item.restorable)
                    ? "checkpoint.partial"
                    : "checkpoint.noRestorable",
              )}
            </p>
          )}
        {error && (
          <p role="alert">
            {t("managed.error")}{" "}
            <Button
              variant="ghost"
              disabled={saving || busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              {t("common.retry")}
            </Button>
          </p>
        )}
        {value && (
          <div className={styles.actions}>
            {(request.pending || hasRestorableFiles) && (
              <Button
                variant="secondary"
                disabled={
                  saving ||
                  busy ||
                  running ||
                  value.state === "expired" ||
                  (!request.pending && !selectedPaths.size)
                }
                onClick={() => (request.pending || confirm ? restoreSelected() : setConfirm(true))}
              >
                {t(
                  // Video rehearsal 2026-11-20: the in-flight restore read 「重试原撤回请求」 for up to
                  // a minute and looked like a failure.
                  saving
                    ? "agentWork.restoreRunning"
                    : request.pending
                      ? "checkpoint.retryRequest"
                      : confirm
                        ? "managed.confirm"
                        : "agentWork.restoreSelected",
                  { count: selectedPaths.size },
                )}
              </Button>
            )}
            {confirm && hasRestorableFiles && (
              <Button variant="ghost" disabled={saving} onClick={() => setConfirm(false)}>
                {t("common.cancel")}
              </Button>
            )}
            <PopupMenu label={t("agentWork.restoreRecords")}>
              <Button variant="ghost" onClick={() => setHistory(!history)}>
                <IconTile icon="clock" tone="teal" size="sm" />
                {t("agentWork.restoreRecords")}
              </Button>
            </PopupMenu>
          </div>
        )}
        {confirm && hasRestorableFiles && (
          <p className={styles.hint}>{t("checkpoint.confirmHint")}</p>
        )}
        {request.pending && !saving && !actionLock.current && (
          <p role="status" className={styles.hint}>
            {t("checkpoint.requestUnconfirmed")}
          </p>
        )}
        {restore && value && <RestoreResults restore={restore} checkpoint={value} />}
        {history && (
          <RestoreHistory
            receipts={receipts}
            checkpoint={value}
            disabled={saving || busy || running}
            act={(kind, receipt) =>
              void act((signal) =>
                api.call(
                  kind === "recover" ? "changes.checkpoints.recover" : "changes.checkpoints.resume",
                  { target, restoreId: receipt.id },
                  { signal, timeoutMs: 120000 },
                ),
              )
            }
          />
        )}
        {history && nextHistory && value && receipts.length < 100 && (
          <Button
            disabled={busy || saving}
            onClick={() => {
              const signal = lifetime.current?.signal;
              if (!signal || signal.aborted || actionLock.current) return;
              actionLock.current = true;
              setSaving(true);
              void api
                .call(
                  "changes.checkpoints.restores",
                  { target, id: value.id, before: nextHistory, limit: 20 },
                  { signal, timeoutMs: 15000 },
                )
                .then((page) => {
                  if (!signal.aborted) {
                    if (page.items.some((item) => item.checkpointId !== value.id))
                      throw Error("checkpoint_scope_mismatch");
                    setReceipts((items) => mergeRestoreReceipts(items, page.items));
                    setNextHistory(page.nextBefore);
                  }
                })
                .catch(() => {
                  if (!signal.aborted) setError(true);
                })
                .finally(() => {
                  if (lifetime.current?.signal === signal) {
                    actionLock.current = false;
                    if (!signal.aborted) setSaving(false);
                  }
                });
            }}
          >
            {t("managed.more")}
          </Button>
        )}
      </div>
    </CheckpointSelection.Provider>
  );
}
