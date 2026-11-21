import type { AuditDetail } from "@pibot/protocol-base";
import type { PreparedToolView, ToolRuntime } from "../runtime/tool-runtime.ts";

/** The run owns the admission set, so parallel calls cannot over-admit a batch. */
export async function readPdfFile(
  runtime: ToolRuntime,
  prepared: PreparedToolView,
  args: Record<string, unknown>,
  audit: AuditDetail,
  parent: AbortSignal,
) {
  parent.throwIfAborted();
  const path = prepared.result.path?.path;
  if (!path) throw new Error("pdf_path_unavailable");
  runtime.context.pdfBatch ??= { admitted: new Set(), read: new Set(), total: 0 };
  const batch = runtime.context.pdfBatch;
  if (!batch.admitted.has(path) && batch.admitted.size >= 20)
    return {
      text: "本步骤最多读取 20 篇 PDF，请由统筹拆成下一步 / PDF batch limit: 20 papers per step; ask the coordinator to split the plan.",
      isError: true,
    };
  if (runtime.admitPdf?.(path) === false)
    return {
      text: "本步骤 PDF 批次不可继续（达到上限或步骤身份已变化），请核对计划 / PDF batch unavailable: step limit reached or step identity changed; review the plan.",
      isError: true,
    };
  batch.admitted.add(path);
  batch.total = Math.max(batch.total, batch.admitted.size);
  const signal = AbortSignal.any([parent, AbortSignal.timeout(45_000)]);
  runtime.assertDispatch(prepared);
  const binary = await runtime.target.readBinary({
    path,
    cwd: prepared.cwd,
    writeRoots: runtime.writeRoots(prepared),
    rootIdentities: prepared.boundary?.roots,
    denyWriteRoots: prepared.boundary?.denyWriteRoots,
    expectedPath: path,
    signal,
  });
  const timing = runtime.timing?.(prepared.call.id);
  const parsed = timing
    ? await timing.measure("post", () => runtime.extractPdf(binary.bytes, signal))
    : await runtime.extractPdf(binary.bytes, signal);
  signal.throwIfAborted();
  runtime.assertDispatch(prepared);
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const limit = typeof args.limit === "number" ? args.limit : 2000;
  const lines = parsed.text.split("\n");
  const text = lines
    .slice(offset, offset + limit)
    .join("\n")
    .slice(0, 24_000);
  const truncated =
    (parsed.pages ?? 0) > 50 ||
    parsed.text.length < parsed.totalChars ||
    offset > 0 ||
    text.length < parsed.text.length;
  if (!parsed.scanned && text.trim()) batch.read.add(path);
  runtime.auditInput(
    {
      ...audit,
      toolCallId: prepared.call.id,
      pdfProgress: { read: batch.read.size, total: batch.total, truncated },
    },
    { kind: "file", path },
  );
  const progress = `${batch.read.size}/${batch.total}`;
  return {
    text: JSON.stringify({
      path: runtime.redact(path),
      type: "pdf",
      text: runtime.redact(text),
      pages: parsed.pages,
      pagesRead: Math.min(parsed.pages ?? 0, 50),
      truncated,
      scanned: parsed.scanned ?? false,
      progress: { read: batch.read.size, total: batch.total },
      totalScope:
        "This step's batch: at most 20 observed PDFs; list the input folder for the full collection and split larger collections",
      note: truncated
        ? "仅阅读部分内容；资料卡须注明覆盖与遗漏 / Partially read; mark coverage and omissions on the source card"
        : undefined,
    }),
    summary:
      runtime.context.language === "zh"
        ? `PDF 已读 ${progress}${truncated ? " · 部分内容" : ""}`
        : `PDF read ${progress}${truncated ? " · partial" : ""}`,
  };
}
