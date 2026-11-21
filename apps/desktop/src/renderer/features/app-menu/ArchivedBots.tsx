import type { Bot } from "@pibot/protocol";
import { BotAvatar, useNavigation, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import archive from "../sidebar/sidebar.module.css";
import { DeleteConversationDialog } from "../workspace/topics/DeleteConversationDialog.tsx";
import styles from "./app-menu.module.css";

export function ArchivedBots({ close }: { close(): void }) {
  const { peer } = useRpc();
  const t = useT();
  const { navigate } = useNavigation();
  const workspace = useWorkspace();
  const [deleting, setDeleting] = useState<Bot>();
  const [bots, setBots] = useState<Bot[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revision, refresh] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const locked = useRef(false);
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    lifetime.current = abort;
    return () => abort.abort();
  }, [peer]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes the current page after failure.
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    setBusy(true);
    setError(false);
    void peer
      .call(
        "bots.archived",
        { before: cursor, limit: 50 },
        {
          signal: abort.signal,
          timeoutMs: 10_000,
        },
      )
      .then((page) => {
        if (abort.signal.aborted) return;
        setBots((old) => {
          const ids = new Set(old.map((bot) => bot.id));
          return cursor ? [...old, ...page.filter((bot) => !ids.has(bot.id))] : page;
        });
        setMore(page.length === 50);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [peer, cursor, revision]);
  const restore = async (botId: string) => {
    const signal = lifetime.current?.signal;
    if (!peer || !signal || signal.aborted || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      const restored = await peer.call(
        "bots.restore",
        { botId },
        {
          signal,
          timeoutMs: 30_000,
        },
      );
      if (signal.aborted) return;
      await workspace.refresh();
      if (signal.aborted) return;
      close();
      navigate({ name: "chat", botId: restored.id });
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      <p className={styles.note}>{t("workspace.archivedBotsHint")}</p>
      {bots.map((bot) => (
        <div key={bot.id} className={archive.archiveRow} data-archived-bot={bot.id}>
          <BotAvatar bot={bot} size={32} />
          <span className={archive.archiveName}>
            {bot.name}
            <small className={`${styles.note} ${styles.archiveDeadline}`}>
              {t("workspace.autoDeleteDays", {
                days: Math.max(
                  0,
                  Math.ceil(
                    (Date.parse(bot.archivedAt ?? new Date().toISOString()) +
                      30 * 86400000 -
                      Date.now()) /
                      86400000,
                  ),
                ),
              })}
            </small>
          </span>
          <Button
            variant="secondary"
            disabled={
              busy ||
              !peer ||
              !bot.archivedAt ||
              Date.now() - Date.parse(bot.archivedAt) >= 30 * 86400000
            }
            onClick={() => void restore(bot.id)}
          >
            {t("workspace.restoreBot")}
          </Button>
          <Button
            variant="ghost"
            className={archive.archiveDelete}
            disabled={!peer || busy}
            onClick={() => setDeleting(bot)}
          >
            {t("workspace.deletePermanently")}
          </Button>
        </div>
      ))}
      {deleting && (
        <DeleteConversationDialog
          key={deleting.id}
          target={{ botId: deleting.id }}
          name={deleting.name}
          permanent
          close={() => setDeleting(undefined)}
          deleted={() => {
            setBots((old) => old.filter((bot) => bot.id !== deleting.id));
            setDeleting(undefined);
            void workspace.refresh();
          }}
        />
      )}
      {!bots.length && !busy && !error && (
        <p className={archive.archiveEmpty}>{t("workspace.archivedBotsEmpty")}</p>
      )}
      {busy && <p role="status">{t("common.loading")}</p>}
      {error && (
        <p role="alert" className={archive.archiveError}>
          {t("workspace.failed")}{" "}
          <Button variant="ghost" disabled={busy} onClick={() => refresh((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {more && (
        <Button variant="ghost" disabled={busy} onClick={() => setCursor(bots.at(-1)?.id)}>
          {t("workspace.more")}
        </Button>
      )}
    </>
  );
}
