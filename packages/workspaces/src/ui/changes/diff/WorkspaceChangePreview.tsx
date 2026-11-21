import { Button } from "@pibot/ui";
import type { ChangeFile, ChangesStatus, ChangesTarget } from "@pibot/workspaces-contract/full";
import { useEffect, useRef, useState } from "react";
import type {
  ManagedResourcesApi,
  ManagedResourceTranslate,
} from "../worktrees/managed-resource-api.ts";
import styles from "../worktrees/managed-resources.module.css";

const tags: Record<ChangeFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "?",
  typechange: "T",
  conflicted: "U",
};
/** Mounted only for expanded roots. Pages and refreshes never change execution bindings. */
export function WorkspaceChangePreview({
  api,
  t,
  target,
  id,
  onView,
}: {
  api: ManagedResourcesApi;
  t: ManagedResourceTranslate;
  target: ChangesTarget;
  id: string;
  onView(path: string): void;
}) {
  const [value, setValue] = useState<ChangesStatus>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const paging = useRef(false);
  const key = JSON.stringify(target);
  // biome-ignore lint/correctness/useExhaustiveDependencies: canonical target and explicit refresh scope the request lifetime.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    paging.current = false;
    setLoading(true);
    setFailed(false);
    setValue(undefined);
    void api
      .call(
        "changes.status",
        { ...target, rootId: id, limit: 50 },
        { signal: controller.signal, timeoutMs: 30_000 },
      )
      .then(
        (result) => {
          if (!controller.signal.aborted) setValue(result);
        },
        () => {
          if (!controller.signal.aborted) setFailed(true);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, key, id, revision]);
  useEffect(
    () =>
      api.on?.("changes.changed", (event) => {
        if (
          event.conversationKey === target.conversationKey &&
          (event.topicId === target.topicId || (event.reason === "folder" && !event.topicId))
        )
          setRevision((current) => current + 1);
      }),
    [api, target.conversationKey, target.topicId],
  );
  const more = async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !value?.nextCursor || loading || paging.current) return;
    paging.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const result = await api.call(
        "changes.status",
        { ...target, rootId: id, cursor: value.nextCursor, limit: 50 },
        { signal, timeoutMs: 30_000 },
      );
      if (signal.aborted) return;
      setValue((current) => ({
        ...result,
        files: [
          ...new Map(
            [...(current?.files ?? []), ...result.files].map((file) => [file.path, file]),
          ).values(),
        ],
      }));
    } catch {
      if (!signal.aborted) setFailed(true);
    } finally {
      if (lifetime.current?.signal === signal) paging.current = false;
      if (!signal.aborted) setLoading(false);
    }
  };
  return (
    <div className={styles.treeFiles}>
      {value && (
        <p className={styles.fileSummary}>
          {t("managed.changedFiles")} · {value.total}
        </p>
      )}
      <ul className={styles.fileList}>
        {value?.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={styles.fileRow}
              title={file.path}
              onClick={() => onView(file.path)}
            >
              <span className={styles.fileTag} title={t(`managed.file.${file.status}`)}>
                {tags[file.status]}
              </span>
              <span className={styles.fileName}>{file.path}</span>
              <span className={styles.fileStats}>
                {file.added !== null && <span className={styles.added}>+{file.added}</span>}
                {file.removed !== null && <span className={styles.removed}>−{file.removed}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {value?.total === 0 && <p className={styles.fileSummary}>{t("managed.noChanges")}</p>}
      {value?.overflow && <p className={styles.error}>{t("managed.tooManyFiles")}</p>}
      {failed && (
        <p className={styles.error} role="alert">
          {t("managed.readError")}{" "}
          <Button
            variant="ghost"
            className={styles.compactButton}
            onClick={() => (value?.nextCursor ? void more() : setRevision((v) => v + 1))}
          >
            {t("managed.refresh")}
          </Button>
        </p>
      )}
      {loading && (
        <p className={styles.fileSummary} role="status">
          {t("managed.loading")}
        </p>
      )}
      {value?.nextCursor && !loading && !failed && (
        <Button variant="ghost" className={styles.compactButton} onClick={() => void more()}>
          {t("managed.moreFiles")}
        </Button>
      )}
    </div>
  );
}
