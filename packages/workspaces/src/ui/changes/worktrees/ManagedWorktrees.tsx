import { Button, Icon } from "@pibot/ui";
import type { ChangesTarget, MethodResults, WorktreeView } from "@pibot/workspaces-contract/full";
import { useEffect, useRef, useState } from "react";
import type { ManagedResourcesApi, ManagedResourceTranslate } from "./managed-resource-api.ts";
import { managedResourceErrorKey } from "./managed-resource-errors.ts";
import styles from "./managed-resources.module.css";
import { useWorktreeViews } from "./use-worktree-views.ts";
import { type WorktreeConfirmation, WorktreeRow } from "./WorktreeRow.tsx";
import { inspectManagedTree, mutateWorktree } from "./worktree-actions.ts";

/** SCM roots are a view; management stays on the separate owner-checked lifecycle. */
export function ManagedWorktrees({
  api,
  target,
  t,
  head,
  currentPath,
  running,
  onBound,
  onView,
  onReview,
}: {
  api: ManagedResourcesApi;
  target: ChangesTarget;
  t: ManagedResourceTranslate;
  head: string | null;
  currentPath: string;
  running: boolean;
  onBound?(): void;
  onView?(id: string, path?: string): void;
  onReview?(receipt: MethodResults["worktrees.review"]): void;
}) {
  const views = useWorktreeViews(api, target);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ReturnType<typeof managedResourceErrorKey>>();
  const [notice, setNotice] = useState<"managed.createdUnbound" | "managed.reviewStarted">();
  const [confirm, setConfirm] = useState<WorktreeConfirmation>();
  const lifetime = useRef<AbortController | null>(null);
  const actionLock = useRef(false);
  const key = JSON.stringify(target);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutations and notices belong to this conversation/topic.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    actionLock.current = false;
    setSaving(false);
    setConfirm(undefined);
    setNotice(undefined);
    setError(undefined);
    return () => controller.abort();
  }, [api, key]);
  const action = async (run: (signal: AbortSignal) => Promise<unknown>, refresh = false) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || actionLock.current || views.loading) return;
    actionLock.current = true;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await run(signal);
      if (!signal.aborted && refresh) {
        setConfirm(undefined);
        views.refresh();
      }
    } catch (error) {
      if (!signal.aborted) {
        setConfirm(undefined);
        const errorKey = managedResourceErrorKey(error);
        setError(errorKey);
        if (
          errorKey === "errors.worktree_integrated_binding_pending" ||
          errorKey === "errors.worktree_integrated_cleanup_pending"
        ) {
          onBound?.();
          views.refresh();
        }
      }
    } finally {
      if (lifetime.current?.signal === signal) actionLock.current = false;
      if (!signal.aborted) setSaving(false);
    }
  };
  const ask = (item: WorktreeView, removing: boolean) =>
    void action(async (signal) => {
      const tree = await inspectManagedTree(api, target, item.rootId, signal);
      if (!signal.aborted) setConfirm({ id: item.rootId, removing, tree });
    });
  const review = (item: WorktreeView) =>
    void action(async (signal) => {
      const receipt = await api.call(
        "worktrees.review",
        { target, rootId: item.rootId },
        { signal, timeoutMs: 30_000 },
      );
      if (signal.aborted) return;
      setNotice("managed.reviewStarted");
      onReview?.(receipt);
    });
  const busy = saving || views.loading;
  const shownError = error ?? views.error;
  return (
    <section className={styles.scmSection} aria-label={t("managed.title")}>
      <div className={styles.heading}>
        <strong>{t("managed.title")}</strong>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            className={styles.compactButton}
            disabled={busy}
            onClick={views.refresh}
          >
            {t("managed.refresh")}
          </Button>
          <Button
            variant="secondary"
            className={styles.compactButton}
            disabled={
              busy ||
              running ||
              !head ||
              (!target.topicId && target.conversationKey.startsWith("dm:"))
            }
            onClick={() =>
              void action(async (signal) => {
                const allocation = await api.call(
                  "worktrees.allocate",
                  { target },
                  { signal, timeoutMs: 120_000 },
                );
                if (!allocation || !head) return;
                await api.call(
                  "worktrees.create",
                  {
                    target,
                    allocationId: allocation.id,
                    requestId: crypto.randomUUID(),
                    expectedSourceHead: head,
                  },
                  { signal, timeoutMs: 120_000 },
                );
                if (!signal.aborted) setNotice("managed.createdUnbound");
              }, true)
            }
          >
            <Icon name="plus" size={14} />
            {t("managed.create")}
          </Button>
        </div>
      </div>
      <p className={styles.hint}>{t("managed.scmHint")}</p>
      {shownError && (
        <p className={styles.error} role="alert">
          {t(shownError)}
        </p>
      )}
      {notice && (
        <p className={styles.hint} role="status">
          {t(notice)}
        </p>
      )}
      {busy && (
        <p className={styles.hint} role="status">
          {t("managed.loading")}
        </p>
      )}
      {!busy && !views.items.length && <p className={styles.hint}>{t("managed.empty")}</p>}
      <ul className={styles.treeList}>
        {views.items.map((item) => (
          <WorktreeRow
            key={item.rootId}
            api={api}
            t={t}
            target={target}
            item={item}
            currentPath={currentPath}
            busy={busy}
            running={running}
            confirm={confirm}
            onConfirm={ask}
            onCancel={() => setConfirm(undefined)}
            onAction={() => {
              if (!confirm) return;
              void action(async (signal) => {
                await mutateWorktree(api, target, confirm.tree, confirm.removing, signal);
                if (!signal.aborted && !confirm.removing) onBound?.();
              }, true);
            }}
            onReview={review}
            onRecover={(item) =>
              void action(
                (signal) =>
                  api.call(
                    "worktrees.recover",
                    { target, id: item.rootId },
                    { signal, timeoutMs: 120_000 },
                  ),
                true,
              )
            }
            onView={(id, path) => onView?.(id, path)}
          />
        ))}
      </ul>
      {views.before && (
        <Button
          variant="ghost"
          className={styles.compactButton}
          disabled={busy}
          onClick={() => void views.more()}
        >
          {t("managed.more")}
        </Button>
      )}
    </section>
  );
}
