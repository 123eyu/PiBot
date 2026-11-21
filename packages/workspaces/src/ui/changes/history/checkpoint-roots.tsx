import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { ChangesTarget, CheckpointCapture } from "@pibot/workspaces-contract/full";
import { type ReactNode, useEffect, useState } from "react";
import type { ManagedResourcesApi } from "../worktrees/managed-resource-api.ts";
import styles from "../worktrees/managed-resources.module.css";

// The concrete RPC result is inferred here rather than widening the shared API port.
async function discover(
  api: ManagedResourcesApi,
  target: ChangesTarget,
  runId: string,
  signal: AbortSignal,
) {
  return api.call("changes.checkpoints.forRun", { target, runId }, { signal, timeoutMs: 15000 });
}
export type CheckpointRoot = Awaited<ReturnType<typeof discover>>[number];

/** Discover every currently authorized root; the receipt is a completion marker, not an index. */
export function CheckpointRoots({
  api,
  target,
  runId,
  capture,
  children,
}: {
  api: ManagedResourcesApi;
  target: ChangesTarget;
  runId?: string;
  capture?: CheckpointCapture;
  children: (root: CheckpointRoot | undefined) => ReactNode;
}) {
  const t = useT(),
    { peer } = useRpc();
  const [records, setRoots] = useState<CheckpointRoot[]>([]);
  const [loadedKey, setLoadedKey] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([target, runId, capture]);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: key freezes the canonical target and receipt.
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    if (!runId || capture?.state !== "retained") {
      setRoots([]);
      setLoadedKey(undefined);
      setBusy(false);
      return;
    }
    setBusy(true);
    void discover(api, JSON.parse(key)[0] as ChangesTarget, runId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setRoots(items);
          setLoadedKey(key);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [api, key, revision]);
  const roots = loadedKey === key ? records : [];
  const chosen =
    roots.find((root) => root.id === selected) ??
    roots.find((root) => root.rootId === target.rootId) ??
    roots.find((root) => root.id === capture?.checkpointId) ??
    roots[0];
  return (
    <>
      {busy && (
        <div className={styles.section}>
          <p role="status" className={styles.hint}>
            {t("common.loading")}
          </p>
        </div>
      )}
      {error && (
        <div className={styles.section}>
          <p role="alert" className={styles.error}>
            {t("managed.error")}
          </p>
          <section className={styles.actions}>
            <Button variant="ghost" onClick={() => setRevision((value) => value + 1)}>
              {t("common.retry")}
            </Button>
          </section>
        </div>
      )}
      {roots.length > 1 && (
        <div className={styles.section}>
          <p className={styles.hint}>{t("checkpoint.chooseRoot")}</p>
          <section aria-label={t("checkpoint.chooseRoot")} className={styles.actions}>
            {roots.map((root) => (
              <Button
                key={root.id}
                variant={root.id === chosen?.id ? "secondary" : "ghost"}
                aria-pressed={root.id === chosen?.id}
                onClick={() => setSelected(root.id)}
              >
                {root.root}
              </Button>
            ))}
          </section>
        </div>
      )}
      {children(chosen)}
    </>
  );
}
