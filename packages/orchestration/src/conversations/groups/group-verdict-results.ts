import type { DeliveryItem, ReportVerdict } from "@pibot/protocol-base";

export function handoffReportVerdict(items: readonly DeliveryItem[]): ReportVerdict | undefined {
  const reports = items.flatMap((item) =>
    item.check === "verdict" && item.status === "pass" && item.verdict ? [item.verdict] : [],
  );
  if (!reports.length) return undefined;
  return {
    verdict: reports.some((report) => report.verdict === "fail") ? "fail" : "pass",
    failures: reports.flatMap((report) => report.failures).slice(0, 10),
  };
}

/** Redaction can expand a short credential into a longer label; bound again before persistence. */
export function boundedReportItems(items: readonly DeliveryItem[]): DeliveryItem[] {
  return items.map((item) =>
    item.verdict
      ? {
          ...item,
          verdict: {
            ...item.verdict,
            failures: item.verdict.failures.slice(0, 10).map((failure) => failure.slice(0, 200)),
          },
        }
      : item,
  );
}
