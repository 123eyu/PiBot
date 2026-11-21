import type { Group } from "@pibot/protocol";
import { useAction, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import archive from "../../sidebar/sidebar.module.css";
import { DeleteConversationDialog } from "../topics/DeleteConversationDialog.tsx";
import styles from "./new-chat.module.css";

/** Paginated archive rows share the sidebar archive dialog; restoring never replays previous group work. */
export function ArchivedGroups() {
  const { peer } = useRpc(),
    t = useT(),
    workspace = useWorkspace(),
    action = useAction();
  const [deleting, setDeleting] = useState<Group>();
  const [rows, setRows] = useState<Group[]>([]);
  const generation = useRef(0);
  const [more, setMore] = useState(false),
    [revision, refresh] = useState(0),
    [loaded, setLoaded] = useState(false);
  const [restored, setRestored] = useState(false),
    [loadError, setLoadError] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 用于重试及恢复后主动刷新归档列表。
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    const token = ++generation.current;
    setLoaded(false);
    setLoadError(false);
    void peer
      .call(
        "groups.list",
        { archived: true, limit: 50 },
        { signal: abort.signal, timeoutMs: 15000 },
      )
      .then(
        (next) => {
          if (!abort.signal.aborted && token === generation.current) {
            setRows(next);
            setMore(next.length === 50);
            setLoaded(true);
          }
        },
        () => {
          if (!abort.signal.aborted && token === generation.current) {
            setLoaded(true);
            setLoadError(true);
          }
        },
      );
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [peer, revision]);
  return (
    <section className={`${styles.feedback} ${archive.archiveList}`}>
      {!loaded && <p role="status">{t("common.loading")}</p>}
      {loadError && (
        <p role="alert" className={archive.archiveError}>
          {t("workspace.failed")}{" "}
          <Button variant="ghost" onClick={() => refresh((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {loaded && !loadError && !rows.length && (
        <p className={archive.archiveEmpty}>{t("group.archivedEmpty")}</p>
      )}
      {rows.map((group) => (
        <div key={group.id} className={archive.archiveRow} data-archived-group={group.id}>
          <span className={archive.archiveGroup} aria-hidden="true">
            {[...group.name][0]}
          </span>
          <span className={archive.archiveName}>{group.name}</span>
          <Button
            variant="secondary"
            disabled={!peer || action.busy}
            onClick={() =>
              void action.run(async (signal) => {
                await peer?.call(
                  "groups.restore",
                  { groupId: group.id },
                  { signal, timeoutMs: 30000 },
                );
                signal.throwIfAborted();
                setRestored(true);
                refresh((n) => n + 1);
                await workspace.refresh();
              })
            }
          >
            {t("group.restore")}
          </Button>
          <Button
            variant="ghost"
            className={archive.archiveDelete}
            disabled={!peer || action.busy}
            onClick={() => setDeleting(group)}
          >
            {t("workspace.dissolveArchived")}
          </Button>
        </div>
      ))}
      {deleting && (
        <DeleteConversationDialog
          key={deleting.id}
          target={{ groupId: deleting.id }}
          name={deleting.name}
          permanent
          close={() => setDeleting(undefined)}
          deleted={() => {
            setRows((old) => old.filter((group) => group.id !== deleting.id));
            setDeleting(undefined);
            refresh((n) => n + 1);
            void workspace.refresh();
          }}
        />
      )}
      {more && (
        <Button
          variant="ghost"
          disabled={action.busy || !loaded || loadError}
          onClick={() =>
            void action.run(async (signal) => {
              const token = generation.current;
              const next = await peer?.call(
                "groups.list",
                { archived: true, limit: 50, before: rows.at(-1)?.id },
                { signal, timeoutMs: 15000 },
              );
              signal.throwIfAborted();
              if (next && token === generation.current) {
                setRows((old) => [...old, ...next]);
                setMore(next.length === 50);
              }
            })
          }
        >
          {t("workspace.more")}
        </Button>
      )}
      {action.error && <p role="alert">{t(action.error)}</p>}
      {restored && (
        <p role="status" className={archive.archiveNotice}>
          {t("group.restoredPaused")}
        </p>
      )}
    </section>
  );
}
