import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { MethodResults } from "@pibot/workspaces-contract/full";
import { useEffect, useMemo, useState } from "react";
import { ChangesIcon } from "../icons.tsx";
import type { ChangesPaneModel } from "../use-changes-pane.ts";
import { ManagedWorktrees } from "./ManagedWorktrees.tsx";
import styles from "./managed-resources.module.css";

export function ManagedResourcesPanel({ open }: { model: ChangesPaneModel; open(): void }) {
  const t = useT();
  return (
    <button type="button" className={styles.workspaceAction} onClick={open}>
      <ChangesIcon name="branch" />
      <span>{t("agentWork.workspaces")}</span>
      <ChangesIcon name="right" size={12} />
    </button>
  );
}
export function WorkspaceResources({
  model,
  back,
  onReview,
}: {
  model: ChangesPaneModel;
  back(): void;
  onReview?(receipt: MethodResults["worktrees.review"]): void;
}) {
  const { peer } = useRpc(),
    t = useT();
  const target = useMemo(
    () => ({
      conversationKey: model.target.conversationKey,
      ...(model.target.topicId ? { topicId: model.target.topicId } : {}),
    }),
    [model.target.conversationKey, model.target.topicId],
  );
  const [head, setHead] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; path?: string }>();
  useEffect(() => {
    if (!pending || model.rootId !== pending.id || model.status?.root.id !== pending.id) return;
    if (pending.path) {
      model.setSelected(pending.path);
      model.setView("diff");
    }
    setPending(undefined);
    back();
  }, [pending, model, back]);
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    setHead(null);
    void peer.call("changes.status", target, { signal: controller.signal, timeoutMs: 30_000 }).then(
      (value) => {
        if (!controller.signal.aborted) setHead(value.git.state === "repo" ? value.git.head : null);
      },
      () => {
        /* The workspace list reports source errors; no stale HEAD is used for creation. */
      },
    );
    return () => controller.abort();
  }, [peer, target]);
  return (
    <section className={styles.workspace}>
      <Button variant="ghost" onClick={back}>
        {t("agentWork.backToChanges")}
      </Button>
      {pending && (
        <div className={styles.actions}>
          <p className={styles.hint} role="status">
            {t(model.state.error ? "managed.readError" : "managed.loading")}
          </p>
          {model.state.error && (
            <Button
              variant="ghost"
              className={styles.compactButton}
              onClick={() => model.source?.refresh()}
            >
              {t("managed.refresh")}
            </Button>
          )}
          <Button
            variant="ghost"
            className={styles.compactButton}
            onClick={() => setPending(undefined)}
          >
            {t("managed.cancel")}
          </Button>
        </div>
      )}
      {peer ? (
        <ManagedWorktrees
          api={peer}
          target={target}
          t={t}
          head={head}
          currentPath={model.status?.root.path ?? ""}
          running={model.running || model.busy}
          onView={(id, path) => {
            model.setRootId(id);
            model.setScope("uncommitted");
            setPending({ id, path });
          }}
          onReview={onReview}
          onBound={() => {
            model.setRootId(undefined);
            model.source?.refresh();
          }}
        />
      ) : (
        <p>{t("agentWork.workspaceUnavailable")}</p>
      )}
    </section>
  );
}
