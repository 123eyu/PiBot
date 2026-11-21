import type { MethodParams, MethodResults } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Icon } from "@pibot/ui";
import { useContext, useEffect, useState } from "react";
import { FilePreviewContext } from "../../file-preview/context.tsx";
import styles from "./office-render-step.module.css";

export function OfficeRenderStep({
  runId,
  messageId,
  toolCallId,
}: MethodParams["office.renderStep"]) {
  const t = useT();
  const { peer } = useRpc();
  const open = useContext(FilePreviewContext);
  const [report, setReport] = useState<MethodResults["office.renderStep"]>();
  useEffect(() => {
    setReport(undefined);
    if (!peer) return;
    const abort = new AbortController();
    void peer
      .call(
        "office.renderStep",
        { runId, messageId, toolCallId },
        { signal: abort.signal, timeoutMs: 10_000 },
      )
      .then((value) => {
        if (!abort.signal.aborted) setReport(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setReport(null);
      });
    return () => abort.abort();
  }, [peer, runId, messageId, toolCallId]);
  if (!peer || report === undefined) return <p role="status">{t("common.loading")}</p>;
  if (report === null) return <p>{t("office.render.expired")}</p>;
  const pageLabel = (page: number) =>
    t(report.format === "xlsx" ? "office.render.sheet" : "office.render.page", { page });
  // Hints (page numbers, heavily shrunk text) never count as problems, so they neither color a
  // page nor change the summary.
  const issues = report.check.issues.filter(({ severity }) => severity !== "hint");
  const hints = report.check.issues.filter(({ severity }) => severity === "hint");
  const flagged = new Set(issues.map(({ page }) => page));
  return (
    <div className={styles.report}>
      {report.imagesExpired ? (
        <p role="status">{t("office.render.issuesExpired")}</p>
      ) : report.status === "rendered" ? (
        <p>
          {t("office.render.summary", {
            pages: report.pages.length,
            issues: issues.length,
          })}
        </p>
      ) : (
        <p role="status">{t(`office.render.status.${report.status}`)}</p>
      )}
      {report.pages.length > 0 && (
        <div className={styles.pages}>
          {report.pages.map(({ page, data }) => (
            <button
              key={page}
              type="button"
              className={styles.page}
              data-issue={flagged.has(page) || undefined}
              disabled={!open}
              aria-label={t("office.render.openPage", { page: pageLabel(page) })}
              onClick={() =>
                open?.({
                  name: report.name,
                  label: { page, sheet: report.format === "xlsx" },
                  source: { officeRender: { runId, messageId, toolCallId, page } },
                })
              }
            >
              <img src={`data:image/png;base64,${data}`} alt="" />
              <span>
                {flagged.has(page) && <Icon name="warning" size={12} />}
                {pageLabel(page)}
              </span>
            </button>
          ))}
        </div>
      )}
      {report.check.activeContent && <p>{t("office.render.activeContent")}</p>}
      {report.check.outOfRange.length > 0 && (
        <p>
          {t("office.render.outOfRange", {
            pages: report.check.outOfRange.map(pageLabel).join(" · "),
          })}
        </p>
      )}
      {issues.length ? (
        <ul>
          {issues.map(({ page, code, value }) => (
            <li key={`${page}:${code}`}>
              {pageLabel(page)} · {t(`office.render.issue.${code}`, { count: value ?? 0 })}
            </li>
          ))}
        </ul>
      ) : report.format === "pptx" && report.check.pages.length > 0 ? (
        <p>{t("office.render.clear")}</p>
      ) : null}
      {hints.length > 0 && (
        <ul className={styles.hints}>
          {hints.map(({ page, code, value }) => (
            <li key={`hint:${page}:${code}`}>
              {t("office.render.hint", {
                page: pageLabel(page),
                text: t(`office.render.issue.${code}`, { count: value ?? 0 }),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
