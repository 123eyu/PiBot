import { Button, Icon, IconButton, IconTile } from "@pibot/ui";
import type { ChangesTarget, ManagedWorktree, WorktreeView } from "@pibot/workspaces-contract/full";
import { useState } from "react";
import { WorkspaceChangePreview } from "../diff/WorkspaceChangePreview.tsx";
import { ChangesIcon } from "../icons.tsx";
import type { ManagedResourcesApi, ManagedResourceTranslate } from "./managed-resource-api.ts";
import styles from "./managed-resources.module.css";

export type WorktreeConfirmation = { id: string; removing: boolean; tree: ManagedWorktree };
export function WorktreeRow({
  api,
  t,
  target,
  item,
  currentPath,
  busy,
  running,
  confirm,
  onConfirm,
  onCancel,
  onAction,
  onReview,
  onRecover,
  onView,
}: {
  api: ManagedResourcesApi;
  t: ManagedResourceTranslate;
  target: ChangesTarget;
  item: WorktreeView;
  currentPath: string;
  busy: boolean;
  running: boolean;
  confirm?: WorktreeConfirmation;
  onConfirm(item: WorktreeView, removing: boolean): void;
  onCancel(): void;
  onAction(): void;
  onReview(item: WorktreeView): void;
  onRecover(item: WorktreeView): void;
  onView(id: string, path?: string): void;
}) {
  const [open, setOpen] = useState(false);
  const confirmation = confirm?.id === item.rootId ? confirm : undefined;
  const tree = confirmation?.tree;
  const mergeBlocked =
    tree &&
    (!tree.head ||
      !tree.sourceHead ||
      tree.sourceClean !== true ||
      (!tree.taskId && tree.clean !== true));
  const removeBlocked = tree && tree.clean !== true;
  const reason = item.locked
    ? "managed.locked"
    : item.prunable
      ? "managed.unavailable"
      : item.managed
        ? "managed.otherScope"
        : "managed.external";
  const readonly = !item.capabilities.integrate && !item.capabilities.remove;
  return (
    <li className={styles.treeItem}>
      <div className={styles.treeRow} data-selected={item.path === currentPath || undefined}>
        <button
          type="button"
          className={styles.treeToggle}
          title={item.path}
          aria-expanded={open}
          aria-controls={`tree-${item.rootId}`}
          disabled={!item.capabilities.view}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.treeArrow} data-open={open}>
            <ChangesIcon name="right" size={14} />
          </span>
          <IconTile icon={item.isMain ? "folder" : "box"} tone="teal" />
          <span className={styles.treeIdentity}>
            <span className={styles.treeName}>{item.name}</span>
            <span className={styles.treeBranch}>
              {item.isMain ? t("managed.main") : (item.branch ?? t("managed.detached"))}
            </span>
          </span>
          {item.isMain && item.branch && <span className={styles.treeBranch}>{item.branch}</span>}
        </button>
        {!item.isMain && (
          <div className={styles.treeActions}>
            <IconButton
              variant="ghost"
              className={styles.treeIcon}
              label={t("managed.integrate")}
              title={t(item.capabilities.integrate ? "managed.integrate" : reason)}
              disabled={busy || running || !item.capabilities.integrate}
              onClick={() => onConfirm(item, false)}
            >
              <ChangesIcon name="branch" size={15} />
            </IconButton>
            <Button
              variant="pill"
              className={styles.treeReview}
              aria-label={t("managed.review")}
              title={t("managed.review")}
              disabled={busy || running || !item.capabilities.review}
              onClick={() => onReview(item)}
            >
              {t("managed.reviewAction")}
            </Button>
            <IconButton
              variant="ghost"
              className={styles.treeIcon}
              label={t("managed.remove")}
              title={t(item.capabilities.remove ? "managed.remove" : reason)}
              disabled={busy || running || !item.capabilities.remove}
              onClick={() => onConfirm(item, true)}
            >
              <Icon name="trash" size={15} />
            </IconButton>
          </div>
        )}
      </div>
      {open && (
        <div id={`tree-${item.rootId}`}>
          <div className={styles.treeMeta}>
            <p className={styles.treePath} title={item.path}>
              {item.path}
            </p>
            <Button
              variant="ghost"
              className={styles.compactButton}
              disabled={!item.capabilities.view}
              onClick={() => onView(item.rootId)}
            >
              {t("managed.view")}
            </Button>
            {!item.isMain && readonly && <p className={styles.hint}>{t(reason)}</p>}
            {item.managed && item.managed.state !== "ready" && (
              <span className={styles.hint}>{t(`managed.state.${item.managed.state}`)}</span>
            )}
            {item.capabilities.recover && (
              <Button
                variant="ghost"
                className={styles.compactButton}
                disabled={busy || running}
                onClick={() => onRecover(item)}
              >
                {t("managed.recover")}
              </Button>
            )}
          </div>
          <WorkspaceChangePreview
            api={api}
            t={t}
            target={target}
            id={item.rootId}
            onView={(path) => onView(item.rootId, path)}
          />
        </div>
      )}
      {confirmation && tree && (
        <div className={styles.treeConfirmation}>
          <p className={styles.hint}>
            {t(
              confirmation.removing
                ? "managed.removeHint"
                : tree.taskId
                  ? "managed.commitIntegrateHint"
                  : "managed.integrateHint",
            )}
          </p>
          {!confirmation.removing && (
            <p className={styles.treePath}>
              {t("managed.destination")} · {tree.integrationPath ?? tree.sourcePath}
            </p>
          )}
          {(confirmation.removing ? removeBlocked : mergeBlocked) && (
            <p className={styles.error}>
              {t(
                tree.sourceClean === false && !confirmation.removing
                  ? "managed.sourceDirty"
                  : "managed.commitFirst",
              )}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              className={styles.compactButton}
              disabled={busy || running || !!(confirmation.removing ? removeBlocked : mergeBlocked)}
              onClick={onAction}
            >
              {t("managed.confirm")}
            </Button>
            <Button
              variant="ghost"
              className={styles.compactButton}
              disabled={busy}
              onClick={onCancel}
            >
              {t("managed.cancel")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
