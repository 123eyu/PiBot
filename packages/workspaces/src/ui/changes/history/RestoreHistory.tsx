import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { FileCheckpoint, FileRestore } from "@pibot/workspaces-contract/full";
import styles from "../worktrees/managed-resources.module.css";
import { restoreCanResume, restoreItemStatus, restoreStatus } from "./checkpoint-presentation.ts";

export function RestoreResults({
  restore,
  checkpoint,
}: {
  restore: FileRestore;
  checkpoint: FileCheckpoint;
}) {
  const t = useT(),
    paths = new Map(checkpoint.items.map((item) => [item.id, item.path]));
  return (
    <div role="status">
      {restore.state === "done" && <p className={styles.hint}>{t("checkpoint.done")}</p>}
      {restore.items.map((item) => (
        <p key={item.itemId} className={item.state === "restored" ? styles.hint : styles.conflict}>
          {paths.get(item.itemId)?.split(/[\\/]/u).at(-1)} · {t(restoreItemStatus(item))}
        </p>
      ))}
      {restore.state === "conflict" && (
        <p className={styles.conflict}>{t("checkpoint.reselectConflict")}</p>
      )}
    </div>
  );
}
export function RestoreHistory({
  receipts,
  checkpoint,
  disabled,
  act,
}: {
  receipts: readonly FileRestore[];
  checkpoint?: FileCheckpoint;
  disabled: boolean;
  act(kind: "recover" | "resume", receipt: FileRestore): void;
}) {
  const t = useT();
  const names = new Map(
    checkpoint?.items.map((item) => [item.id, item.path.split(/[\\/]/u).at(-1)]),
  );
  return (
    <div className={styles.list}>
      {!receipts.length && <p className={styles.hint}>{t("checkpoint.noRestores")}</p>}
      {receipts.map((receipt) => (
        <article className={styles.item} key={receipt.id}>
          <time>{new Date(receipt.createdAt).toLocaleString()}</time>
          <span>{t(restoreStatus(receipt))}</span>
          <p className={styles.path}>
            {receipt.items
              .map((item) => names.get(item.itemId))
              .filter(Boolean)
              .join(", ")}
          </p>
          {receipt.state === "conflict" && (
            <p className={styles.conflict}>{t("checkpoint.reselectConflict")}</p>
          )}
          {(restoreCanResume(receipt) ||
            receipt.state === "intent" ||
            receipt.state === "running") && (
            <div className={styles.actions}>
              <Button disabled={disabled} onClick={() => act("recover", receipt)}>
                {t("checkpoint.recover")}
              </Button>
              {restoreCanResume(receipt) && (
                <Button disabled={disabled} onClick={() => act("resume", receipt)}>
                  {t("checkpoint.resume")}
                </Button>
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
