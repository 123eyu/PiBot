import type { ExecutionCollectionChange } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, type IconName, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./execution.module.css";
import { PopupMenu } from "./PopupMenu.tsx";
import { useExecution } from "./workspace.tsx";

export function CollectionActions({
  target,
  archived = false,
  disabled = false,
  icon,
  showLabel = false,
}: {
  target: Omit<ExecutionCollectionChange, "action">;
  archived?: boolean;
  disabled?: boolean;
  icon?: IconName;
  /** A visible 「管理」 label where a bare icon was too easy to miss (the plan header). */
  showLabel?: boolean;
}) {
  const { peer } = useRpc(),
    t = useT(),
    workspace = useExecution();
  const [confirm, setConfirm] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState<
    "execution.collectionBusy" | "execution.collectionConflict" | "execution.collectionError"
  >();
  const lifetime = useRef<AbortController | undefined>(undefined),
    lock = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: receipts survive version updates but not a peer or entry change.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [peer, target.botId, target.conversationId, target.id]);
  const current = workspace?.topics.find((topic) => topic.botId === target.botId)?.plan;
  const occupied = archived && target.kind === "plan" && !!(current?.items.length || current?.goal);
  const change = async (action: ExecutionCollectionChange["action"]) => {
    const signal = lifetime.current?.signal;
    if (!peer || !signal || signal.aborted || lock.current) return;
    lock.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await peer.call(
        "execution.collection.change",
        { ...target, action },
        { signal, timeoutMs: 10000 },
      );
      if (!signal.aborted) setConfirm(false);
    } catch (cause) {
      if (!signal.aborted) {
        const message = cause instanceof Error ? cause.message : "";
        setError(
          message.includes("execution_collection_busy")
            ? "execution.collectionBusy"
            : message.includes("execution_collection_changed")
              ? "execution.collectionConflict"
              : "execution.collectionError",
        );
      }
    } finally {
      lock.current = false;
      if (!signal.aborted) setSaving(false);
    }
  };
  return (
    <PopupMenu
      label={t(showLabel ? "execution.manage" : "execution.manageEntry")}
      icon={icon}
      showLabel={showLabel}
      disabled={disabled || !peer}
      onOpenChange={(open) => {
        if (!open) {
          setConfirm(false);
          setError(undefined);
        }
      }}
    >
      {confirm ? (
        <>
          <p className={styles.hint}>
            {t(target.kind === "task" ? "execution.deleteTaskHint" : "execution.deletePlanHint")}
          </p>
          <Button disabled={saving} onClick={() => void change("delete")}>
            <IconTile icon="trash" tone="red" size="sm" />
            {t("execution.deleteEntry")}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={() => setConfirm(false)}>
            {t("common.cancel")}
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="ghost"
            disabled={saving || !!occupied}
            onClick={() => void change(archived ? "restore" : "archive")}
          >
            <IconTile
              icon={archived ? "refresh" : "box"}
              tone={archived ? "green" : "orange"}
              size="sm"
            />
            {t(archived ? "execution.restoreEntry" : "execution.archiveEntry")}
          </Button>
          {occupied && <p className={styles.hint}>{t("execution.restorePlanHint")}</p>}
          <Button
            variant="ghost"
            className={styles.menuDanger}
            disabled={saving}
            onClick={() => setConfirm(true)}
          >
            <IconTile icon="trash" tone="red" size="sm" />
            {t("execution.deleteEntry")}
          </Button>
        </>
      )}
      {saving && <p role="status">{t("common.loading")}</p>}
      {error && (
        <p role="alert" className={styles.hint}>
          {t(error)}
        </p>
      )}
    </PopupMenu>
  );
}
