import type { AuditDetail } from "@pibot/protocol-base";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

/**
 * The inputs a run used are facts the app observed, so a receipt never has to trust the
 * model's account. One row per successful read: the path (file) or hostname (page), never content.
 * A failed audit write must not fail a read that already succeeded, so it is logged instead.
 */
export function auditInput(
  local: LocalService,
  context: ToolRunContext,
  fields: AuditDetail,
  input: { kind: "file"; path: string } | { kind: "web"; domain: string },
) {
  try {
    local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: input.kind === "file" ? "file.read" : "web.fetched",
      summary: input.kind === "file" ? "Read file / 读取了文件" : "Fetched page / 读取了网页",
      detail:
        input.kind === "file"
          ? { ...fields, path: input.path }
          : { ...fields, domain: input.domain.slice(0, 253) },
    });
    if (input.kind === "file" && fields.pdfProgress)
      local.collaboration?.observePdf?.(
        context,
        fields.pdfProgress,
        input.path,
        context.pdfBatch?.read.has(input.path) ?? false,
      );
  } catch {
    local.deps.logger.warn(
      JSON.stringify({
        module: "receipt",
        event: "input_audit_failed",
        botId: context.botId,
        runId: context.runId,
        input: input.kind,
      }),
    );
  }
}
