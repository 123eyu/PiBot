import { type OfficePreview, type PreviewSource, RpcError } from "@pibot/office-contract/full";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useId, useRef, useState } from "react";
import { OfficeContentView } from "./OfficeContentView.tsx";
import { OfficeOpenControl } from "./OfficeOpenControl.tsx";
import { OfficeSheetTabs } from "./OfficeSheetTabs.tsx";
import { OfficeWarnings } from "./OfficeWarnings.tsx";
import styles from "./office.module.css";

export function OfficePreviewPane({ name, source }: { name: string; source: PreviewSource }) {
  const { peer } = useRpc();
  const t = useT();
  const panelId = useId();
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [result, setResult] = useState<OfficePreview>();
  const [failed, setFailed] = useState<"changed" | "failed">();
  const revision = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState<Record<number, number>>({});
  const [sheet, setSheet] = useState(0);
  const [retry, setRetry] = useState(0);
  const offset = pages[sheet] ?? 0;
  const sourceKey = JSON.stringify(source);
  const setOffset = (update: (value: number) => number) =>
    setPages((previous) => ({ ...previous, [sheet]: update(previous[sheet] ?? 0) }));
  const limit = name.toLowerCase().endsWith(".pptx") ? 1 : 30;
  const refresh = () => {
    revision.current = undefined;
    setPages({});
    setSheet(0);
    setRetry((value) => value + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly invalidates the previous bounded request; sourceKey names the source
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancelRequest = () => {
      if (cancelled) return;
      cancelled = true;
      void peer.call("office.cancel", { requestId }, { timeoutMs: 3_000 }).catch(() => {
        // Cancellation failure remains bounded by the server's 50-second deadline; do not retry.
      });
    };
    setLoading(true);
    setFailed(undefined);
    setResult(undefined);
    void peer
      .call(
        "office.preview",
        {
          ...source,
          requestId,
          expectedRevision: revision.current,
          offset,
          sheet,
          limit,
        },
        { signal: abort.signal, timeoutMs: 60_000 },
      )
      .then((value) => {
        if (!abort.signal.aborted) {
          revision.current = value.revision;
          setResult(value);
          setSheetNames(value.sheetNames ?? []);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setFailed(
            error instanceof RpcError && error.message === "office_changed" ? "changed" : "failed",
          );
      })
      .finally(() => {
        cancelRequest();
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      abort.abort();
      cancelRequest();
    };
  }, [peer, sourceKey, offset, sheet, limit, retry]);
  return (
    <section className={styles.preview} aria-label={name}>
      <div className={styles.toolbar}>
        <OfficeOpenControl name={name} source={source} />
        <Button
          variant="ghost"
          disabled={loading || !peer}
          onClick={refresh}
          title={t("office.refresh")}
        >
          <Icon name="refresh" size={15} />
          {t("office.refresh")}
        </Button>
      </div>
      <section
        className={styles.body}
        id={panelId}
        role={sheetNames.length ? "tabpanel" : "region"}
        aria-label={sheetNames[sheet] ?? t("office.contentPreview")}
      >
        {loading && <p role="status">{t("common.loading")}</p>}
        {failed && (
          <div role="alert">
            <p className={styles.error}>
              {t(failed === "changed" ? "office.changed" : "office.previewFailed")}
            </p>
            <Button
              variant="secondary"
              onClick={failed === "changed" ? refresh : () => setRetry((value) => value + 1)}
            >
              {t(failed === "changed" ? "office.refresh" : "common.retry")}
            </Button>
          </div>
        )}
        {result && (
          <>
            <details className={styles.previewInfo}>
              <summary>{t("office.previewInfo")}</summary>
              <p>{t("office.layoutNotice")}</p>
              <OfficeWarnings warnings={result.warnings} />
            </details>
            {result.truncated && (
              <p className={`${styles.notice} ${styles.truncated}`}>{t("office.truncated")}</p>
            )}
            <OfficeContentView content={result.content} offset={offset} />
          </>
        )}
      </section>
      {sheetNames.length > 0 && (
        <OfficeSheetTabs names={sheetNames} selected={sheet} panelId={panelId} select={setSheet} />
      )}
      <footer className={styles.footer}>
        <Button
          variant="ghost"
          disabled={!result || loading || offset === 0}
          onClick={() => setOffset((value) => Math.max(0, value - limit))}
        >
          <Icon name="back" />
          {t("office.previous")}
        </Button>
        {result && (
          <span>
            {t("office.position", {
              start: result.total ? offset + 1 : 0,
              end: Math.min(offset + limit, result.total),
              total: result.total,
            })}
          </span>
        )}
        <Button
          variant="ghost"
          disabled={!result || loading || offset + limit >= result.total}
          onClick={() => setOffset((value) => value + limit)}
        >
          {t("office.next")}
          <Icon name="chevronRight" />
        </Button>
        {result && (
          <span className={styles.revision}>
            {t("office.revision", { revision: result.revision.slice(0, 12) })}
          </span>
        )}
      </footer>
    </section>
  );
}
