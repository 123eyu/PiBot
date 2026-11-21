import type { MemoryOwner, MethodResults } from "@pibot/protocol";
import { useRpc, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "./memory-settings.module.css";

export function MemoryDetails({ owner, id }: { owner: MemoryOwner; id: string }) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const [before, setBefore] = useState<number>();
  const [snapshot, setSnapshot] = useState<{
    peer: typeof peer;
    value: MethodResults["memory.details"];
  }>();
  const data = snapshot?.peer === peer ? snapshot?.value : undefined;
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry requests the same history page again.
  useEffect(() => {
    const lifetime = new AbortController();
    setLoading(true);
    setFailed(false);
    if (peer)
      void peer
        .call(
          "memory.details",
          { scope: owner.scope, ownerId: owner.ownerId, id, before },
          { signal: lifetime.signal, timeoutMs: 30_000 },
        )
        .then((value) => {
          if (!lifetime.signal.aborted)
            setSnapshot((previous) => ({
              peer,
              value: {
                ...value,
                history:
                  before && previous?.peer === peer
                    ? [...previous.value.history, ...value.history]
                    : value.history,
              },
            }));
        })
        .catch(() => {
          if (!lifetime.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!lifetime.signal.aborted) setLoading(false);
        });
    else {
      setFailed(true);
      setLoading(false);
    }
    return () => lifetime.abort();
  }, [peer, owner.scope, owner.ownerId, id, before, retry]);
  return (
    <div className={styles.detailsBody}>
      <p className={styles.meta}>{t("memorySettings.historyNote")}</p>
      {data?.sources.length
        ? data.sources.map((source) => (
            <p className={styles.meta} key={source.key}>
              {/* Without a conversation it was typed here; "Pi · 手动保存 / 导入…" read as both. */}
              {source.conversationTitle && source.botName
                ? t("memorySettings.source", {
                    bot: source.botName,
                    conversation: source.conversationTitle,
                    date: source.createdAt
                      ? new Date(source.createdAt).toLocaleString(language)
                      : "—",
                  })
                : source.createdAt
                  ? t("memorySettings.sourceManual", {
                      date: new Date(source.createdAt).toLocaleString(language),
                    })
                  : t("memorySettings.sourceManualUndated")}
            </p>
          ))
        : !loading && <p className={styles.meta}>{t("memorySettings.manual")}</p>}
      <ol className={styles.history}>
        {data?.history.map((entry) => (
          <li key={entry.version}>
            <p className={styles.meta}>
              {new Date(entry.changedAt).toLocaleString(language)} ·{" "}
              {t(`workspace.category.${entry.category ?? "other"}`)}
              {entry.archivedAt ? ` · ${t("memorySettings.archived")}` : ""}
              {entry.baseline ? ` · ${t("memorySettings.baseline")}` : ""}
            </p>
            <p className={styles.text}>{entry.text}</p>
          </li>
        ))}
      </ol>
      {loading && <p role="status">{t("common.loading")}</p>}
      {failed && (
        <p className={styles.error} role="alert">
          {t("memorySettings.failed")}{" "}
          <Button variant="pill" className={styles.small} onClick={() => setRetry((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!!data && data.history.length > 0 && data.history.length % 20 === 0 && (
        <Button
          variant="pill"
          className={styles.small}
          disabled={loading}
          onClick={() => setBefore(data.history.at(-1)?.version)}
        >
          {t("memorySettings.more")}
        </Button>
      )}
    </div>
  );
}
