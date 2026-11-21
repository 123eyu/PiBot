import pathApi from "node:path";
import type { Acceptance, Deliverable, DeliveryItem } from "@pibot/protocol-base";
import {
  citationEvidence,
  type DeliverySources,
  markdownOutline,
  sectionKey,
} from "./delivery-citations.ts";
import { deliveryFile } from "./delivery-path.ts";

export interface DeliveryRead {
  state: "missing" | "empty" | "ok" | "unreadable";
  text?: string;
  columns?: string[];
  hasChart?: boolean;
}
export async function extraDeliveryCheck(
  acceptance: Acceptance,
  deliverable: Deliverable,
  file: DeliveryRead,
  folder: string,
  sources: DeliverySources,
  signal: AbortSignal,
): Promise<
  Pick<DeliveryItem, "status" | "reason" | "missing" | "referenceIssues" | "citationContext">
> {
  const { resolve, dirname } = sources.access?.paths ?? pathApi;
  signal.throwIfAborted();
  const fail = (reason: DeliveryItem["reason"], missing: string[] = []) => ({
    status: "fail" as const,
    reason,
    missing: missing.slice(0, 10),
  });
  const pass = { status: "pass" as const, reason: null, missing: [] };
  const text = file.text ?? "";
  if (acceptance.check === "hasChart") {
    if (file.hasChart) return pass;
    if (file.hasChart === undefined) {
      for (const match of markdownOutline(text)
        .join("\n")
        .replace(/`[^`]*`/g, "")
        .matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) {
        let path = match[1] ?? match[2] ?? "";
        try {
          path = decodeURIComponent(path);
        } catch {
          continue;
        }
        if (/^[a-z]+:|^\/\/|[?#]/i.test(path)) continue;
        try {
          const target = resolve(folder, dirname(deliverable.path), path);
          if ((await deliveryFile(folder, target, signal, undefined, sources.access))?.size)
            return pass;
        } catch (error) {
          if (sources.access?.remote) throw error;
          signal.throwIfAborted();
        }
      }
    }
    return fail("no_chart");
  }
  if (acceptance.check === "tableColumns") {
    const headers = file.columns ? [file.columns] : markdownHeaders(text);
    const missing = headers.map((header) => {
      const names = new Set(header.map(columnKey));
      return (acceptance.columns ?? []).filter((column) => !names.has(columnKey(column)));
    });
    if (missing.some((items) => !items.length)) return pass;
    return fail(
      "missing_columns",
      missing.sort((a, b) => a.length - b.length)[0] ?? acceptance.columns,
    );
  }
  // Missing audit pages cannot prove either complete provenance or absent sources.
  if (sources.incomplete) return { status: "manual", reason: "unreadable", missing: [] };
  const extension = deliverable.path.split(".").at(-1)?.toLowerCase();
  const format =
    deliverable.kind !== "any"
      ? deliverable.kind
      : extension === "docx" || extension === "xlsx" || extension === "pptx"
        ? extension
        : "md";
  const evidence = await citationEvidence(
    text,
    folder,
    sources,
    signal,
    format,
    deliverable.sections,
    deliverable.path,
  );
  const failed = (reason: DeliveryItem["reason"], missing: string[] = []) => ({
    ...fail(evidence.hasSources ? reason : "no_sources", evidence.hasSources ? missing : []),
    citationContext: evidence.citationContext,
    ...(evidence.referenceIssues.length ? { referenceIssues: evidence.referenceIssues } : {}),
  });
  if (acceptance.check === "minCitations")
    return evidence.count >= (acceptance.min ?? 1)
      ? pass
      : failed("too_few_citations", [
          `${evidence.count}/${acceptance.min ?? 1}`,
          ...evidence.unresolved,
        ]);
  if (acceptance.check === "sectionsSourced") {
    const missing = (deliverable.sections ?? []).filter(
      (section) => ![...evidence.sourced].some((heading) => heading.includes(sectionKey(section))),
    );
    return missing.length ? failed("section_unsourced", missing) : pass;
  }
  if (!evidence.hasSources) return failed("no_sources");
  return evidence.unresolved.length ? failed("unresolved_citations", evidence.unresolved) : pass;
}
const columnKey = (value: string) =>
  value.normalize("NFKC").trim().replace(/[*_`]/g, "").replace(/\s+/g, " ").toLowerCase();
function markdownHeaders(text: string): string[][] {
  const lines = markdownOutline(text);
  const split = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((value) => value.replace(/\\\|/g, "|").trim());
  return lines.flatMap((line, index) => {
    if (!line.includes("|") || !lines[index + 1]?.includes("|")) return [];
    const separators = split(lines[index + 1] ?? "");
    const header = split(line);
    return separators.length === header.length &&
      separators.every((cell) => /^:?-{3,}:?$/.test(cell))
      ? [header]
      : [];
  });
}
